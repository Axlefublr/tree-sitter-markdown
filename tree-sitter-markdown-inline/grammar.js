// This grammar only concerns the inline structure according to the CommonMark Spec
// (https://spec.commonmark.org/0.30/#inlines)
// For more information see README.md

/// <reference types="tree-sitter-cli/dsl" />

const common = require('../common/common');

// Levels used for dynmic precedence. Ideally
// n * PRECEDENCE_LEVEL_EMPHASIS > PRECEDENCE_LEVEL_LINK for any n, so maybe the
// maginuted of these values should be increased in the future
const PRECEDENCE_LEVEL_EMPHASIS = 1;
const PRECEDENCE_LEVEL_LINK = 10;
const PRECEDENCE_LEVEL_HTML = 100;
// Dynamic precedence of `required_argument`. It has to beat a shortcut link (PRECEDENCE_LEVEL_LINK)
// inside of it, so that `<a [b]>` is an argument. But `[t](<dest>)` has to stay an `inline_link`,
// which scores 3 * PRECEDENCE_LEVEL_LINK against a shortcut link plus this, so it has to stay below
// 2 * PRECEDENCE_LEVEL_LINK.
const PRECEDENCE_LEVEL_REQUIRED_ARGUMENT = 15;
// Dynamic precedence of every single token in an argument type. It is counted per token (not once
// per type) so that the longest possible type always wins: ending the type early would let the rest
// be parsed as something with its own precedence, like the `<String>` in `<a>:Vec<String>`
// (a `required_argument`), and that must not outscore the tokens it takes away from the type.
const PRECEDENCE_LEVEL_ARGUMENT_TYPE = 8;

// Punctuation characters as specified in
// https://github.github.com/gfm/#ascii-punctuation-character
const PUNCTUATION_CHARACTERS_REGEX = '!-/:-@\\[-`\\{-~';


// !!!
// Notice the call to `add_inline_rules` which generates some additional rules related to parsing
// inline contents in different contexts.
// !!!
module.exports = grammar(add_inline_rules({
    name: 'markdown_inline',

    externals: $ => [
        // An `$._error` token is never valid  and gets emmited to kill invalid parse branches. Concretely
        // this is used to decide wether a newline closes a paragraph and together and it gets emitted
        // when trying to parse the `$._trigger_error` token in `$.link_title`.
        $._error,
        $._trigger_error,

        // Opening and closing delimiters for code spans. These are sequences of one or more backticks.
        // An opening token does not mean the text after has to be a code span if there is no closing token
        $._code_span_start,
        $._code_span_close,

        // Opening and closing delimiters for emphasis.
        $._emphasis_open_star,
        $._emphasis_open_underscore,
        $._emphasis_close_star,
        $._emphasis_close_underscore,

        // For emphasis we need to tell the parser if the last character was a whitespace (or the
        // beginning of a line) or a punctuation. These tokens never actually get emitted.
        $._last_token_whitespace,
        $._last_token_punctuation,

        $._strikethrough_open,
        $._strikethrough_close,

        // Opening and closing delimiters for latex. These are sequences of one or more dollar signs.
        // An opening token does not mean the text after has to be latex if there is no closing token
        $._latex_span_start,
        $._latex_span_close,

        // Token emmited when encountering opening delimiters for a leaf span
        // e.g. a code span, that does not have a matching closing span
        $._unclosed_span
    ],
    precedences: $ => [
        // [$._strong_emphasis_star, $._inline_element_no_star],
        [$._strong_emphasis_star_no_link, $._inline_element_no_star_no_link],
        // [$._strong_emphasis_underscore, $._inline_element_no_underscore],
        [$._strong_emphasis_underscore_no_link, $._inline_element_no_underscore_no_link],
        [$.hard_line_break, $._whitespace],
        [$.hard_line_break, $._text_base],
    ],
    // More conflicts are defined in `add_inline_rules`
    conflicts: $ => [

        [$._required_argument, $._text_base],
        [$._required_argument],
        [$._shortcut_link_with_type],
        [$._argument_type],
        [$._html_comment, $._text_base],

        [$._link_text_non_empty, $._inline_element],
        [$._link_text_non_empty, $._inline_element_no_star],
        [$._link_text_non_empty, $._inline_element_no_underscore],
        [$._link_text_non_empty, $._inline_element_no_tilde],
        [$._link_text, $._inline_element],
        [$._link_text, $._inline_element_no_star],
        [$._link_text, $._inline_element_no_underscore],
        [$._link_text, $._inline_element_no_tilde],

        [$._image_description, $._image_description_non_empty, $._text_base],
        // [$._image_description, $._image_description_non_empty, $._text_inline],
        // [$._image_description, $._image_description_non_empty, $._text_inline_no_star],
        // [$._image_description, $._image_description_non_empty, $._text_inline_no_underscore],

        [$._image_shortcut_link, $._image_description],
        [$.shortcut_link, $._link_text],
        [$.link_destination, $.link_title],
        [$._link_destination_parenthesis, $.link_title],

        [$.wiki_link, $._inline_element],
        [$.wiki_link, $._inline_element_no_star],
        [$.wiki_link, $._inline_element_no_underscore],
        [$.wiki_link, $._inline_element_no_tilde],
    ],
    extras: $ => [],

    rules: {
        inline: $ => seq(optional($._last_token_whitespace), $._inline),

        ...common.rules,


        // A lot of inlines are defined in `add_inline_rules`, including:
        //
        // * collections of inlines
        // * emphasis
        // * textual content
        //
        // This is done to reduce code duplication, as some inlines need to be parsed differently
        // depending on the context. For example inlines in ATX headings may not contain newlines.

        code_span: $ => seq(
            alias($._code_span_start, $.code_span_delimiter),
            repeat(choice($._text_base, '[', ']', $._soft_line_break, $._html_tag)),
            alias($._code_span_close, $.code_span_delimiter)
        ),

        latex_block: $ => seq(
            alias($._latex_span_start, $.latex_span_delimiter),
            repeat(choice($._text_base, '[', ']', $._soft_line_break, $._html_tag, $.backslash_escape)),
            alias($._latex_span_close, $.latex_span_delimiter),
        ),

        // Different kinds of links:
        // * inline links (https://github.github.com/gfm/#inline-link)
        // * full reference links (https://github.github.com/gfm/#full-reference-link)
        // * collapsed reference links (https://github.github.com/gfm/#collapsed-reference-link)
        // * shortcut links (https://github.github.com/gfm/#shortcut-reference-link)
        //
        // Dynamic precedence is distributed as granular as possible to help the parser decide
        // while parsing which branch is the most important.
        //
        // https://github.github.com/gfm/#links
        _link_text: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, choice(
            $._link_text_non_empty,
            seq('[', ']')
        )),
        _link_text_non_empty: $ => seq('[', alias($._inline_no_link, $.link_text), ']'),
        shortcut_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, $._link_text_non_empty),
        full_reference_link: $ => prec.dynamic(2 * PRECEDENCE_LEVEL_LINK, seq(
            $._link_text,
            $.link_label
        )),
        collapsed_reference_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq(
            $._link_text,
            '[',
            ']'
        )),
        inline_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq(
            $._link_text,
            '(',
            repeat(choice($._whitespace, $._soft_line_break)),
            optional(seq(
                choice(
                    seq(
                        $.link_destination,
                        optional(seq(
                            repeat1(choice($._whitespace, $._soft_line_break)),
                            $.link_title
                        ))
                    ),
                    $.link_title,
                ),
                repeat(choice($._whitespace, $._soft_line_break)),
            )),
            ')'
        )),

        wiki_link: $ => prec.dynamic(2 * PRECEDENCE_LEVEL_LINK, seq(
            '[', '[',
            alias($._wiki_link_destination, $.link_destination),
            optional(seq(
                '|',
                alias($._wiki_link_text, $.link_text)
            )),
            ']', ']'
            )
        ),

        _wiki_link_destination: $ => repeat1(choice(
            $._word,
            common.punctuation_without($, ['[',']', '|']),
            $._whitespace,
        )),

        _wiki_link_text: $ => repeat1(choice(
            $._word,
            common.punctuation_without($, ['[',']']),
            $._whitespace,
        )),

        // Images work exactly like links with a '!' added in front.
        //
        // https://github.github.com/gfm/#images
        image: $ => choice(
            $._image_inline_link,
            $._image_shortcut_link,
            $._image_full_reference_link,
            $._image_collapsed_reference_link
        ),
        _image_inline_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq(
            $._image_description,
            '(',
            repeat(choice($._whitespace, $._soft_line_break)),
            optional(seq(
                choice(
                    seq(
                        $.link_destination,
                        optional(seq(
                            repeat1(choice($._whitespace, $._soft_line_break)),
                            $.link_title
                        ))
                    ),
                    $.link_title,
                ),
                repeat(choice($._whitespace, $._soft_line_break)),
            )),
            ')'
        )),
        _image_shortcut_link: $ => prec.dynamic(3 * PRECEDENCE_LEVEL_LINK, $._image_description_non_empty),
        _image_full_reference_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq($._image_description, $.link_label)),
        _image_collapsed_reference_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq($._image_description, '[', ']')),
        _image_description: $ => prec.dynamic(3 * PRECEDENCE_LEVEL_LINK, choice($._image_description_non_empty, seq('!', '[', prec(1, ']')))),
        _image_description_non_empty: $ => seq('!', '[', alias($._inline, $.image_description), prec(1, ']')),

        // Autolinks. Uri autolinks actually accept protocolls of arbitrary length which does not
        // align with the spec. This is because the binary for the grammar gets to large if done
        // otherwise as tree-sitters code generation is not very concise for this type of regex.
        //
        // Unlike in the spec, a uri autolink requires `://` after the scheme, and email autolinks
        // don't exist: `<key:value>` and `<user@host>` are required arguments instead.
        //
        // https://github.github.com/gfm/#autolinks
        uri_autolink: $ => /<[a-zA-Z][a-zA-Z0-9+\.\-][a-zA-Z0-9+\.\-]*:\/\/[^ \t\r\n<>]*>/,

        // Required arguments: `<arg>`. These take the place of raw html, so what is inside of the
        // angle brackets can be pretty much anything. The content is raw, like in a code span: no
        // other inline syntax is parsed inside of it. It can't start with whitespace (so `x < y`
        // stays text) but can contain whitespace after that. It ends at the first `>` and can't
        // contain a `<` or a newline. The angle brackets are anonymous nodes: they are not part of
        // `required_argument`.
        //
        // This is ambiguous with plain text at the `<`, hence the conflict with `$._text_base`.
        _required_argument: $ => prec.dynamic(PRECEDENCE_LEVEL_REQUIRED_ARGUMENT, seq(
            '<',
            alias($._required_argument_content, $.required_argument),
            '>',
            optional($._argument_type)
        )),
        _required_argument_content: $ => seq(
            $._required_argument_start,
            repeat(choice(
                $._word,
                $._whitespace,
                common.punctuation_without($, ['<', '>']),
            )),
        ),
        // The first token of the content. Right after the `<` the external scanner is asked for
        // everything that is valid for plain text too, so for a `*`, `_`, `~`, backtick or `$` it
        // may emit an opening delimiter instead of a plain punctuation character. Those have to be
        // accepted here as content, otherwise an argument starting with one of them would not be
        // an argument. (Inside the content the scanner is not asked for them anymore.)
        _required_argument_start: $ => choice(
            $._word,
            common.punctuation_without($, ['<', '>']),
            $._delimiter_as_text,
        ),
        // Opening delimiters that the external scanner may emit instead of plain punctuation.
        // Anywhere they should be taken as raw text, they have to be listed through this rule.
        _delimiter_as_text: $ => choice(
            $._emphasis_open_star,
            $._emphasis_open_underscore,
            $._strikethrough_open,
            $._code_span_start,
            $._latex_span_start,
            $._unclosed_span,
        ),

        // The type of an argument: `<arg>:type` and `[arg]:type`. The `:` has to come right after
        // the `>` or `]`, can't be followed by another `:` or whitespace, and the type goes on
        // until the next whitespace. Every word (letters and digits) in it is an `argument_type`,
        // everything else (`<`, `>`, `[`, `]`, `,`, `::`...) is left unnamed. Like the content of
        // a `required_argument` this is raw: no other inline syntax is parsed inside of it.
        // That also means it swallows what comes right after it, like the `*` in `*<a>:T*`.
        _argument_type: $ => seq(
            ':',
            argument_type_part($, [':']),
            repeat(argument_type_part($, [])),
        ),

        // A `[arg]`, with an optional type. The type is a sibling of `shortcut_link`, not a part of
        // it, so that the node still covers just the `[arg]`.
        _shortcut_link_with_type: $ => seq($.shortcut_link, optional($._argument_type)),

        // Raw html. Only html comments are supported, everything else in angle brackets is a
        // required argument (see above). As with html blocks we do not emit additional information
        // as this is best done by a proper html tree-sitter grammar.
        //
        // https://github.github.com/gfm/#raw-html
        _html_tag: $ => $._html_comment,
        _html_comment: $ => prec.dynamic(PRECEDENCE_LEVEL_HTML, seq(
            '<!--',
            optional(seq(
                choice(
                    $._word,
                    $._whitespace,
                    $._soft_line_break,
                    common.punctuation_without($, ['-', '>']),
                    seq(
                        '-',
                        common.punctuation_without($, ['>']),
                    )
                ),
                repeat(prec.right(choice(
                    $._word,
                    $._whitespace,
                    $._soft_line_break,
                    common.punctuation_without($, ['-']),
                    seq(
                        '-',
                        choice(
                            $._word,
                            $._whitespace,
                            $._soft_line_break,
                            common.punctuation_without($, ['-']),
                        )
                    )
                ))),
            )),
            '-->'
        )),

        // A hard line break.
        //
        // https://github.github.com/gfm/#hard-line-breaks
        hard_line_break: $ => seq(choice('\\', $._whitespace_ge_2), $._soft_line_break),
        _text: $ => choice($._word, common.punctuation_without($, []), $._whitespace),

        // Whitespace is divided into single whitespaces and multiple whitespaces as wee need this
        // information for hard line breaks.
        _whitespace_ge_2: $ => /\t| [ \t]+/,
        _whitespace: $ => seq(choice($._whitespace_ge_2, / /), optional($._last_token_whitespace)),

        // Other than whitespace we tokenize into strings of digits, punctuation characters
        // (handled by `common.punctuation_without`) and strings of any other characters. This way the
        // lexer does not have to many different states, which makes it a lot easier to make
        // conflicts work.
        _word: $ => choice($._word_no_digit, $._digits),
        _word_no_digit: $ => new RegExp('[^' + PUNCTUATION_CHARACTERS_REGEX + ' \\t\\n\\r0-9]+(_+[^' + PUNCTUATION_CHARACTERS_REGEX + ' \\t\\n\\r0-9]+)*'),
        _digits: $ => /[0-9][0-9_]*/,
        _soft_line_break: $ => seq($._newline_token, optional($._last_token_whitespace)),

        _inline_base: $ => prec.right(repeat1(choice(
            $.image,
            $._soft_line_break,
            $.backslash_escape,
            $.hard_line_break,
            $.uri_autolink,
            $.entity_reference,
            $.numeric_character_reference,
            (common.EXTENSION_LATEX ? $.latex_block : choice()),
            $.code_span,
            alias($._html_tag, $.html_tag),
            $._required_argument,
            $._text_base,
            common.EXTENSION_TAGS ? $.tag : choice(),
            $._unclosed_span,
        ))),
        _text_base: $ => choice(
            $._word,
            common.punctuation_without($, ['[', ']']),
            $._whitespace,
            '<!--',
        ),
        _text_inline_no_link: $ => choice(
            $._text_base,
            $._emphasis_open_star,
            $._emphasis_open_underscore,
            $._unclosed_span,
        ),

        ...(common.EXTENSION_TAGS ? {
            tag: $ => /#[0-9]*[a-zA-Z_\-\/][a-zA-Z_\-\/0-9]*/,
        } : {}),

    },
}));

// One token of an argument type, see `_argument_type`. `excluded` is the punctuation not allowed.
function argument_type_part($, excluded) {
    return prec.dynamic(PRECEDENCE_LEVEL_ARGUMENT_TYPE, choice(
        alias($._word, $.argument_type),
        common.punctuation_without($, excluded),
        $._delimiter_as_text,
    ));
}

// This function adds some extra inline rules. This is done to reduce code duplication, as some
// rules may not contain newlines, characters like '*' and '_', ... depending on the context.
//
// This is by far the most ugly part of this code and should be cleaned up.
function add_inline_rules(grammar) {
    let conflicts = [];
    for (let link of [true, false]) {
        let suffix_link = link ? "" : "_no_link";
        for (let delimiter of [false, "star", "underscore", "tilde"]) {
            let suffix_delimiter = delimiter ? "_no_" + delimiter : "";
            let suffix = suffix_delimiter + suffix_link;
            grammar.rules["_inline_element" + suffix] = $ => {
                let elements = [
                    $._inline_base,
                    alias($['_emphasis_star' + suffix_link], $.emphasis),
                    alias($['_strong_emphasis_star' + suffix_link], $.strong_emphasis),
                    alias($['_emphasis_underscore' + suffix_link], $.emphasis),
                    alias($['_strong_emphasis_underscore' + suffix_link], $.strong_emphasis),
                ];
                if (common.EXTENSION_STRIKETHROUGH) {
                    elements.push(alias($['_strikethrough' + suffix_link], $.strikethrough));
                }
                if (delimiter !== "star") {
                    elements.push($._emphasis_open_star);
                }
                if (delimiter !== "underscore") {
                    elements.push($._emphasis_open_underscore);
                }
                if (delimiter !== "tilde") {
                    elements.push($._strikethrough_open);
                }
                if (link) {
                    elements = elements.concat([
                        $._shortcut_link_with_type,
                        $.full_reference_link,
                        $.collapsed_reference_link,
                        $.inline_link,
                        // (common.EXTENSION_WIKI_LINK && $.wiki_link),
                        seq(choice('[', ']'), optional($._last_token_punctuation)),
                    ]);
                    if (common.EXTENSION_WIKI_LINK) {
                        elements.push($.wiki_link);
                    }
                }
                return choice(...elements);
            };
            grammar.rules["_inline" + suffix] = $ => repeat1($["_inline_element" + suffix]);
            if (delimiter !== "star") {
                conflicts.push(['_emphasis_star' + suffix_link, '_inline_element' + suffix_delimiter + suffix_link]);
                conflicts.push(['_emphasis_star' + suffix_link, '_strong_emphasis_star' + suffix_link, '_inline_element' + suffix_delimiter + suffix_link]);
            }
            // The `_no_link` variants of this conflict are not needed, tree-sitter warns about them.
            if (link && (delimiter == 'star' || delimiter == 'underscore')) {
                conflicts.push(['_strong_emphasis_' + delimiter + suffix_link, '_inline_element_no_' + delimiter]);
            }
            if (delimiter !== "underscore") {
                conflicts.push(['_emphasis_underscore' + suffix_link, '_inline_element' + suffix_delimiter + suffix_link]);
                conflicts.push(['_emphasis_underscore' + suffix_link, '_strong_emphasis_underscore' + suffix_link, '_inline_element' + suffix_delimiter + suffix_link]);
            }
            if (delimiter !== "tilde") {
                conflicts.push(['_strikethrough' + suffix_link, '_inline_element' + suffix_delimiter + suffix_link]);
            }
        }

        if (common.EXTENSION_STRIKETHROUGH) {
            grammar.rules['_strikethrough' + suffix_link] = $ => prec.dynamic(PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._strikethrough_open, $.emphasis_delimiter), optional($._last_token_punctuation), $['_inline' + '_no_tilde' + suffix_link], alias($._strikethrough_close, $.emphasis_delimiter)));
        }
        grammar.rules['_emphasis_star' + suffix_link] = $ => prec.dynamic(PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._emphasis_open_star, $.emphasis_delimiter), optional($._last_token_punctuation), $['_inline' + '_no_star' + suffix_link], alias($._emphasis_close_star, $.emphasis_delimiter)));
        grammar.rules['_strong_emphasis_star' + suffix_link] = $ => prec.dynamic(2 * PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._emphasis_open_star, $.emphasis_delimiter), $['_emphasis_star' + suffix_link], alias($._emphasis_close_star, $.emphasis_delimiter)));
        grammar.rules['_emphasis_underscore' + suffix_link] = $ => prec.dynamic(PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._emphasis_open_underscore, $.emphasis_delimiter), optional($._last_token_punctuation), $['_inline' + '_no_underscore' + suffix_link], alias($._emphasis_close_underscore, $.emphasis_delimiter)));
        grammar.rules['_strong_emphasis_underscore' + suffix_link] = $ => prec.dynamic(2 * PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._emphasis_open_underscore, $.emphasis_delimiter), $['_emphasis_underscore' + suffix_link], alias($._emphasis_close_underscore, $.emphasis_delimiter)));
    }

    let old = grammar.conflicts
    grammar.conflicts = $ => {
        let cs = old($);
        for (let conflict of conflicts) {
            let c = [];
            for (let rule of conflict) {
                c.push($[rule]);
            }
            cs.push(c);
        }
        return cs;
    }

    return grammar;
}
