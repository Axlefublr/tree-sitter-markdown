#include "tree_sitter/parser.h"

#ifdef _MSC_VER
#define UNUSED __pragma(warning(suppress : 4101))
#else
#define UNUSED __attribute__((unused))
#endif

// For explanation of the tokens see grammar.js
typedef enum {
    ERROR,
    TRIGGER_ERROR,
    CODE_SPAN_START,
    CODE_SPAN_CLOSE,
    EMPHASIS_OPEN_STAR,
    EMPHASIS_OPEN_UNDERSCORE,
    EMPHASIS_CLOSE_STAR,
    EMPHASIS_CLOSE_UNDERSCORE,
    LAST_TOKEN_WHITESPACE,
    LAST_TOKEN_PUNCTUATION,
    STRIKETHROUGH_OPEN,
    STRIKETHROUGH_CLOSE,
    LATEX_SPAN_START,
    LATEX_SPAN_CLOSE,
    UNCLOSED_SPAN,
    ARROW_OPEN,
    ARROW_TYPE_END
} TokenType;

// Determines if a character is punctuation as defined by the markdown spec.
static bool is_punctuation(int32_t chr) {
    return (chr >= '!' && chr <= '/') || (chr >= ':' && chr <= '@') ||
           (chr >= '[' && chr <= '`') || (chr >= '{' && chr <= '~');
}

// The semantic operator U+21C9 that makes the word after it an argument
// type. This is the only place that knows about it besides `_arrow_argument` in
// grammar.js: it is not derived from `SEMANTIC_OPERATORS` in common.js.
#define ARROW 0x21C9

static bool is_newline_or_eof(TSLexer *lexer) {
    return lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
           lexer->eof(lexer);
}

// State bitflags used with `Scanner.state`

// TODO
static UNUSED const uint8_t STATE_EMPHASIS_DELIMITER_MOD_3 = 0x3;
// Current delimiter run is opening
static const uint8_t STATE_EMPHASIS_DELIMITER_IS_OPEN = 0x1 << 2;

// Convenience function to emit the error token. This is done to stop invalid
// parse branches. Specifically:
// 1. When encountering a newline after a line break that ended a paragraph, and
// no new block
//    has been opened.
// 2. When encountering a new block after a soft line break.
// 3. When a `$._trigger_error` token is valid, which is used to stop parse
// branches through
//    normal tree-sitter grammar rules.
//
// See also the `$._soft_line_break` and `$._paragraph_end_newline` tokens in
// grammar.js
static bool error(TSLexer *lexer) {
    lexer->result_symbol = ERROR;
    return true;
}

typedef struct {
    // Parser state flags
    uint8_t state;
    uint8_t code_span_delimiter_length;
    uint8_t latex_span_delimiter_length;
    // The number of characters remaining in the currrent emphasis delimiter
    // run.
    uint8_t num_emphasis_delimiters_left;

} Scanner;

// Write the whole state of a Scanner to a byte buffer
static unsigned serialize(Scanner *s, char *buffer) {
    unsigned size = 0;
    buffer[size++] = (char)s->state;
    buffer[size++] = (char)s->code_span_delimiter_length;
    buffer[size++] = (char)s->latex_span_delimiter_length;
    buffer[size++] = (char)s->num_emphasis_delimiters_left;
    return size;
}

// Read the whole state of a Scanner from a byte buffer
// `serizalize` and `deserialize` should be fully symmetric.
static void deserialize(Scanner *s, const char *buffer, unsigned length) {
    s->state = 0;
    s->code_span_delimiter_length = 0;
    s->latex_span_delimiter_length = 0;
    s->num_emphasis_delimiters_left = 0;
    if (length > 0) {
        size_t size = 0;
        s->state = (uint8_t)buffer[size++];
        s->code_span_delimiter_length = (uint8_t)buffer[size++];
        s->latex_span_delimiter_length = (uint8_t)buffer[size++];
        s->num_emphasis_delimiters_left = (uint8_t)buffer[size++];
    }
}

static bool parse_leaf_delimiter(TSLexer *lexer, uint8_t *delimiter_length,
                                 const bool *valid_symbols,
                                 const char delimiter,
                                 const TokenType open_token,
                                 const TokenType close_token) {
    uint8_t level = 0;
    while (lexer->lookahead == delimiter) {
        lexer->advance(lexer, false);
        level++;
    }
    lexer->mark_end(lexer);
    if (level == *delimiter_length && valid_symbols[close_token]) {
        *delimiter_length = 0;
        lexer->result_symbol = close_token;
        return true;
    }
    if (valid_symbols[open_token]) {
        // Parse ahead to check if there is a closing delimiter
        size_t close_level = 0;
        while (!lexer->eof(lexer)) {
            if (lexer->lookahead == delimiter) {
                close_level++;
            } else {
                if (close_level == level) {
                    // Found a matching delimiter
                    break;
                }
                close_level = 0;
            }
            lexer->advance(lexer, false);
        }
        if (close_level == level) {
            *delimiter_length = level;
            lexer->result_symbol = open_token;
            return true;
        }
        if (valid_symbols[UNCLOSED_SPAN]) {
            lexer->result_symbol = UNCLOSED_SPAN;
            return true;
        }
    }
    return false;
}

static bool parse_backtick(Scanner *s, TSLexer *lexer,
                           const bool *valid_symbols) {
    return parse_leaf_delimiter(lexer, &s->code_span_delimiter_length,
                                valid_symbols, '`', CODE_SPAN_START,
                                CODE_SPAN_CLOSE);
}

static bool parse_dollar(Scanner *s, TSLexer *lexer,
                         const bool *valid_symbols) {
    return parse_leaf_delimiter(lexer, &s->latex_span_delimiter_length,
                                valid_symbols, '$', LATEX_SPAN_START,
                                LATEX_SPAN_CLOSE);
}

static bool parse_star(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
    lexer->advance(lexer, false);
    // If `num_emphasis_delimiters_left` is not zero then we already decided
    // that this should be part of an emphasis delimiter run, so interpret it as
    // such.
    if (s->num_emphasis_delimiters_left > 0) {
        // The `STATE_EMPHASIS_DELIMITER_IS_OPEN` state flag tells us wether it
        // should be open or close.
        if ((s->state & STATE_EMPHASIS_DELIMITER_IS_OPEN) &&
            valid_symbols[EMPHASIS_OPEN_STAR]) {
            s->state &= (~STATE_EMPHASIS_DELIMITER_IS_OPEN);
            lexer->result_symbol = EMPHASIS_OPEN_STAR;
            s->num_emphasis_delimiters_left--;
            return true;
        }
        if (valid_symbols[EMPHASIS_CLOSE_STAR]) {
            lexer->result_symbol = EMPHASIS_CLOSE_STAR;
            s->num_emphasis_delimiters_left--;
            return true;
        }
    }
    lexer->mark_end(lexer);
    // Otherwise count the number of stars
    uint8_t star_count = 1;
    while (lexer->lookahead == '*') {
        star_count++;
        lexer->advance(lexer, false);
    }
    bool line_end = lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
                    lexer->eof(lexer);
    if (valid_symbols[EMPHASIS_OPEN_STAR] ||
        valid_symbols[EMPHASIS_CLOSE_STAR]) {
        // The desicion made for the first star also counts for all the
        // following stars in the delimiter run. Rembemer how many there are.
        s->num_emphasis_delimiters_left = star_count - 1;
        // Look ahead to the next symbol (after the last star) to find out if it
        // is whitespace punctuation or other.
        bool next_symbol_whitespace =
            line_end || lexer->lookahead == ' ' || lexer->lookahead == '\t';
        bool next_symbol_punctuation = is_punctuation(lexer->lookahead);
        // Information about the last token is in valid_symbols. See grammar.js
        // for these tokens for how this is done.
        if (valid_symbols[EMPHASIS_CLOSE_STAR] &&
            !valid_symbols[LAST_TOKEN_WHITESPACE] &&
            (!valid_symbols[LAST_TOKEN_PUNCTUATION] ||
             next_symbol_punctuation || next_symbol_whitespace)) {
            // Closing delimiters take precedence
            s->state &= ~STATE_EMPHASIS_DELIMITER_IS_OPEN;
            lexer->result_symbol = EMPHASIS_CLOSE_STAR;
            return true;
        }
        if (!next_symbol_whitespace && (!next_symbol_punctuation ||
                                        valid_symbols[LAST_TOKEN_PUNCTUATION] ||
                                        valid_symbols[LAST_TOKEN_WHITESPACE])) {
            s->state |= STATE_EMPHASIS_DELIMITER_IS_OPEN;
            lexer->result_symbol = EMPHASIS_OPEN_STAR;
            return true;
        }
    }
    return false;
}

static bool parse_tilde(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
    lexer->advance(lexer, false);
    // If `num_emphasis_delimiters_left` is not zero then we already decided
    // that this should be part of an emphasis delimiter run, so interpret it as
    // such.
    if (s->num_emphasis_delimiters_left > 0) {
        // The `STATE_EMPHASIS_DELIMITER_IS_OPEN` state flag tells us wether it
        // should be open or close.
        if ((s->state & STATE_EMPHASIS_DELIMITER_IS_OPEN) &&
            valid_symbols[STRIKETHROUGH_OPEN]) {
            s->state &= (~STATE_EMPHASIS_DELIMITER_IS_OPEN);
            lexer->result_symbol = STRIKETHROUGH_OPEN;
            s->num_emphasis_delimiters_left--;
            return true;
        }
        if (valid_symbols[STRIKETHROUGH_CLOSE]) {
            lexer->result_symbol = STRIKETHROUGH_CLOSE;
            s->num_emphasis_delimiters_left--;
            return true;
        }
    }
    lexer->mark_end(lexer);
    // Otherwise count the number of tildes
    uint8_t star_count = 1;
    while (lexer->lookahead == '~') {
        star_count++;
        lexer->advance(lexer, false);
    }
    bool line_end = lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
                    lexer->eof(lexer);
    if (valid_symbols[STRIKETHROUGH_OPEN] ||
        valid_symbols[STRIKETHROUGH_CLOSE]) {
        // The desicion made for the first star also counts for all the
        // following stars in the delimiter run. Rembemer how many there are.
        s->num_emphasis_delimiters_left = star_count - 1;
        // Look ahead to the next symbol (after the last star) to find out if it
        // is whitespace punctuation or other.
        bool next_symbol_whitespace =
            line_end || lexer->lookahead == ' ' || lexer->lookahead == '\t';
        bool next_symbol_punctuation = is_punctuation(lexer->lookahead);
        // Information about the last token is in valid_symbols. See grammar.js
        // for these tokens for how this is done.
        if (valid_symbols[STRIKETHROUGH_CLOSE] &&
            !valid_symbols[LAST_TOKEN_WHITESPACE] &&
            (!valid_symbols[LAST_TOKEN_PUNCTUATION] ||
             next_symbol_punctuation || next_symbol_whitespace)) {
            // Closing delimiters take precedence
            s->state &= ~STATE_EMPHASIS_DELIMITER_IS_OPEN;
            lexer->result_symbol = STRIKETHROUGH_CLOSE;
            return true;
        }
        if (!next_symbol_whitespace && (!next_symbol_punctuation ||
                                        valid_symbols[LAST_TOKEN_PUNCTUATION] ||
                                        valid_symbols[LAST_TOKEN_WHITESPACE])) {
            s->state |= STATE_EMPHASIS_DELIMITER_IS_OPEN;
            lexer->result_symbol = STRIKETHROUGH_OPEN;
            return true;
        }
    }
    return false;
}

static bool parse_underscore(Scanner *s, TSLexer *lexer,
                             const bool *valid_symbols) {
    lexer->advance(lexer, false);
    // If `num_emphasis_delimiters_left` is not zero then we already decided
    // that this should be part of an emphasis delimiter run, so interpret it as
    // such.
    if (s->num_emphasis_delimiters_left > 0) {
        // The `STATE_EMPHASIS_DELIMITER_IS_OPEN` state flag tells us wether it
        // should be open or close.
        if ((s->state & STATE_EMPHASIS_DELIMITER_IS_OPEN) &&
            valid_symbols[EMPHASIS_OPEN_UNDERSCORE]) {
            s->state &= (~STATE_EMPHASIS_DELIMITER_IS_OPEN);
            lexer->result_symbol = EMPHASIS_OPEN_UNDERSCORE;
            s->num_emphasis_delimiters_left--;
            return true;
        }
        if (valid_symbols[EMPHASIS_CLOSE_UNDERSCORE]) {
            lexer->result_symbol = EMPHASIS_CLOSE_UNDERSCORE;
            s->num_emphasis_delimiters_left--;
            return true;
        }
    }
    lexer->mark_end(lexer);
    // Otherwise count the number of stars
    uint8_t underscore_count = 1;
    while (lexer->lookahead == '_') {
        underscore_count++;
        lexer->advance(lexer, false);
    }
    bool line_end = lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
                    lexer->eof(lexer);
    if (valid_symbols[EMPHASIS_OPEN_UNDERSCORE] ||
        valid_symbols[EMPHASIS_CLOSE_UNDERSCORE]) {
        // The desicion made for the first underscore also counts for all the
        // following underscores in the delimiter run. Rembemer how many there are.
        s->num_emphasis_delimiters_left = underscore_count - 1;
        // Look ahead to the next symbol (after the last underscore) to find out if it
        // is whitespace punctuation or other.
        bool next_symbol_whitespace =
            line_end || lexer->lookahead == ' ' || lexer->lookahead == '\t';
        bool next_symbol_punctuation = is_punctuation(lexer->lookahead);
        // Information about the last token is in valid_symbols. See grammar.js
        // for these tokens for how this is done.
        if (valid_symbols[EMPHASIS_CLOSE_UNDERSCORE] &&
            !valid_symbols[LAST_TOKEN_WHITESPACE] &&
            (!valid_symbols[LAST_TOKEN_PUNCTUATION] ||
             next_symbol_punctuation || next_symbol_whitespace)) {
            // Closing delimiters take precedence
            s->state &= ~STATE_EMPHASIS_DELIMITER_IS_OPEN;
            lexer->result_symbol = EMPHASIS_CLOSE_UNDERSCORE;
            return true;
        }
        if (!next_symbol_whitespace && (!next_symbol_punctuation ||
                                        valid_symbols[LAST_TOKEN_PUNCTUATION] ||
                                        valid_symbols[LAST_TOKEN_WHITESPACE])) {
            s->state |= STATE_EMPHASIS_DELIMITER_IS_OPEN;
            lexer->result_symbol = EMPHASIS_OPEN_UNDERSCORE;
            return true;
        }
    }
    return false;
}

// Decides whether a U+21C9 starts an argument type, see `_arrow_argument` in
// grammar.js. All of these have to be true:
// 1. it is at the start of a line or right after whitespace (the grammar tells
//    us through `LAST_TOKEN_WHITESPACE`), and not part of a longer run of
//    semantic operators,
// 2. it is followed by exactly one space,
// 3. then comes a word (no whitespace in it),
// 4. and the word ends the line, or is followed by at least two spaces. A
//    single trailing space before the end of the line is fine too.
// Only the U+21C9 itself is part of the token, the rest is just looked at.
static bool parse_arrow(TSLexer *lexer, const bool *valid_symbols) {
    if (!valid_symbols[ARROW_OPEN] || !valid_symbols[LAST_TOKEN_WHITESPACE]) {
        return false;
    }
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    if (lexer->lookahead != ' ') {
        return false;
    }
    lexer->advance(lexer, false);
    bool has_word = false;
    while (lexer->lookahead != ' ' && lexer->lookahead != '\t' &&
           !is_newline_or_eof(lexer)) {
        lexer->advance(lexer, false);
        has_word = true;
    }
    if (!has_word) {
        return false;
    }
    uint32_t spaces = 0;
    while (lexer->lookahead == ' ') {
        lexer->advance(lexer, false);
        spaces++;
    }
    if (spaces < 2 && !is_newline_or_eof(lexer)) {
        return false;
    }
    lexer->result_symbol = ARROW_OPEN;
    return true;
}

static bool scan(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
    // A normal tree-sitter rule decided that the current branch is invalid and
    // now "requests" an error to stop the branch
    if (valid_symbols[TRIGGER_ERROR]) {
        return error(lexer);
    }

    // The end of an argument type after a U+21C9: the first whitespace or the
    // end of the line. This token is empty. The start already made sure that
    // the type ends like this, see `parse_arrow`.
    if (valid_symbols[ARROW_TYPE_END] &&
        (lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
         is_newline_or_eof(lexer))) {
        lexer->result_symbol = ARROW_TYPE_END;
        return true;
    }

    // Decide which tokens to consider based on the first non-whitespace
    // character
    switch (lexer->lookahead) {
        case ARROW:
            return parse_arrow(lexer, valid_symbols);
        case '`':
            // A backtick could mark the beginning or ending of a code span or a
            // fenced code block.
            return parse_backtick(s, lexer, valid_symbols);
        case '$':
            return parse_dollar(s, lexer, valid_symbols);
        case '*':
            // A star could either mark the beginning or ending of emphasis, a
            // list item or thematic break. This code is similar to the code for
            // '_' and '+'.
            return parse_star(s, lexer, valid_symbols);
        case '_':
            return parse_underscore(s, lexer, valid_symbols);
        case '~':
            return parse_tilde(s, lexer, valid_symbols);
    }
    return false;
}

void *tree_sitter_markdown_inline_external_scanner_create() {
    Scanner *s = (Scanner *)malloc(sizeof(Scanner));
    deserialize(s, NULL, 0);
    return s;
}

bool tree_sitter_markdown_inline_external_scanner_scan(
    void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;
    return scan(scanner, lexer, valid_symbols);
}

unsigned tree_sitter_markdown_inline_external_scanner_serialize(void *payload,
                                                                char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    return serialize(scanner, buffer);
}

void tree_sitter_markdown_inline_external_scanner_deserialize(void *payload,
                                                              const char *buffer,
                                                              unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    deserialize(scanner, buffer, length);
}

void tree_sitter_markdown_inline_external_scanner_destroy(void *payload) {
    Scanner *scanner = (Scanner *)payload;
    free(scanner);
}
