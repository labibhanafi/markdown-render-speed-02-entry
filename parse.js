// parse.js — a fast drop-in replacement for marked 18.1.3's marked.parse()
// with marked's default options (gfm: true, breaks: false, pedantic: false).
//
// For every input string, parse(markdown) returns exactly the HTML that
// marked 18.1.3 returns. The grammar implemented here is marked's own
// (marked is MIT licensed; see MARKED-LICENSE.txt and the NOTICE in
// README.md): a block phase that scans the source with anchored grammar
// rules in marked's priority order while collecting link reference
// definitions, then an inline phase that renders each block's text using
// marked's delimiter-run emphasis algorithm over a masked copy of the
// source (links, code spans, raw HTML and backslash escapes masked out, so
// emphasis never reaches inside them).
//
// Where this engine differs from marked is mechanics, not output:
//   - blocks and inline runs render straight to strings; there is no token
//     tree and no separate parser pass;
//   - the inline scanner dispatches on the current character, so plain text
//     is consumed by one tight scan instead of a cascade of failing rule
//     attempts at every position;
//   - the closer scan shared by every emphasis opener in a run is computed
//     once per run with a plain character sweep.
//
// The behaviour contract, case by case, is the competition's practice set:
// 652 CommonMark 0.31.2 examples, 28 GFM 0.29 extension examples and 40
// generated READMEs, all byte-identical to marked 18.1.3.

/* ------------------------------------------------------------------ *
 * Grammar tables: marked 18.1.3's grammar (markedjs/marked, tag
 * v18.1.3, src/rules.ts), GFM rule set, defaults only.
 * ------------------------------------------------------------------ */

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
};

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`));
const blockquoteBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`));
const _tagNames = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const htmlBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tagNames})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));

/* Block rules that are single literals in marked's grammar. */
const spaceRule = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRule = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRule = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hrRule = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const headingRule = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const listRule = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const blockTextRule = /^[^\n]+/;

/* Inline rules that are single literals in marked's grammar. */
const escapeRule = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRule = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRule = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const anyPunctuation = /\\([\p{P}\p{S}])/gu;
const anyPunctuationOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

/* Composed rules: marked's grammar assembles these from named pieces with
 * its edit() helper; the assembled expressions follow, verbatim. */
const lheadingRule = new RegExp("^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)", "");
const blockquoteRule = new RegExp("^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+", "");
const tableRule = new RegExp("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)", "");
const paragraphRule = new RegExp("^([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)| *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)|[ \\t]+\\n)[^\\n]+)*)", "");
const defRule = new RegExp("^ {0,3}\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)((?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)", "");
const htmlBlockRule = new RegExp("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))", "i");
const blockSkipRule = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g");
const emStrongLDelimRule = new RegExp("^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?", "u");
const emStrongRDelimAstRule = new RegExp("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu");
const emStrongRDelimUndRule = new RegExp("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])", "gu");
const delLDelimRule = new RegExp("^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])", "u");
const delRDelimRule = new RegExp("^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])", "gu");
const autolinkRule = new RegExp("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>", "");
const tagRule = new RegExp("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>", "");
const linkRule = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)", "");
const reflinkRule = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]", "");
const nolinkRule = new RegExp("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?", "");
const reflinkSearchRule = new RegExp("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g");
const urlRule = new RegExp("^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])", "");
const inlineTextRule = new RegExp("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))", "");
const punctuationRule = new RegExp("^((?![*_])[\\s\\p{P}\\p{S}])", "u");

/* ------------------------------------------------------------------ *
 * Small shared helpers (marked's src/helpers.ts semantics).
 * ------------------------------------------------------------------ */

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch) => escapeReplacements[ch];

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (other.escapeTest.test(html)) {
      return html.replace(other.escapeReplace, getEscapeReplacement);
    }
  } else if (other.escapeTestNoEncode.test(html)) {
    return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
  }
  return html;
}

const numericRefRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmpRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericCharacterReferences(text) {
  if (!text.includes('&#') || !numericRefRe.test(text)) {
    return text;
  }
  return text.replace(numericRefOrAmpRe, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '�';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  // Fast path: encodeURI leaves a string untouched when it holds none of
  // the characters encodeURI escapes (and '%' survives its %25 round trip),
  // which is nearly every URL a document carries.
  let clean = true;
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 34 || c === 60 || c === 62 || c === 91 || c === 92
      || c === 93 || c === 94 || c === 96 || c === 123 || c === 124 || c === 125) {
      clean = false;
      break;
    }
  }
  if (clean) return href;
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

/** Remove a trailing run of `c` (or, with invert, of non-`c`). */
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

/** Unicode case fold + whitespace collapse for link labels. */
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Index of the closer that unbalances `b` in `str`, -2 if more opens than closes, else -1. */
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    if (escaped) return '|';
    return ' |';
  });
  const cells = row.split(other.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

/** Expand tabs to the next multiple-of-4 column, starting at column `indent`. */
function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(other.beginningSpace);
      if (matchIndentInNode === null) return node;
      const [indentInNode] = matchIndentInNode;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

/**
 * Does the ']' ending this link label fall inside an inline HTML tag or
 * autolink that starts within the label? If so the label does not end there.
 */
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = inlineCodeRule.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = tagRule.exec(tokenSrc) || autolinkRule.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Block phase. Produces a flat array of block nodes per container;
 * paragraph / text / heading nodes and table cells are also pushed to
 * S.inlineQueue in creation order (their inline source is rendered
 * only after the whole block phase, when every link definition in the
 * document is known — the queue order is the order marked lexes them).
 * ------------------------------------------------------------------ */

function tokSpace(src) {
  const cap = spaceRule.exec(src);
  if (cap && cap[0].length > 0) {
    return { t: 'space', raw: cap[0] };
  }
}

function tokCode(src) {
  const cap = blockCodeRule.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(other.codeRemoveIndent, '');
    return { t: 'code', raw, text, lang: undefined };
  }
}

function tokFences(src) {
  const cap = fencesRule.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      t: 'code',
      raw,
      text,
      lang: cap[2] ? cap[2].trim().replace(anyPunctuation, '$1') : cap[2],
    };
  }
}

function tokHeading(S, src) {
  const cap = headingRule.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (other.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || other.endingSpaceTabChar.test(trimmed)) {
        text = trimmed.trim();
      }
    }
    const node = {
      t: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[1].length,
      text,
    };
    S.inlineQueue.push(node);
    return node;
  }
}

function tokHr(src) {
  const cap = hrRule.exec(src);
  if (cap) {
    return { t: 'hr', raw: rtrim(cap[0], '\n') };
  }
}

function tokBlockquote(S, src) {
  const cap = blockquoteRule.exec(src);
  if (!cap) return;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (other.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(
        other.blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    const top = S.top;
    S.top = true;
    blockTokens(S, currentText, tokens, true);
    S.top = top;

    if (lines.length === 0) break;

    const lastToken = tokens.at(-1);
    if (lastToken?.t === 'code' || lastToken?.t === 'heading' || lastToken?.t === 'hr'
      || lastToken?.t === 'html' || lastToken?.t === 'table') {
      break;
    } else if (lastToken?.t === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(S, newText);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) {
        raw = `${raw}\n${consumed.join('\n')}`;
      }
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) {
        continue;
      }
      break;
    } else if (lastToken?.t === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(S, newText);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { t: 'blockquote', raw, tokens, text };
}

/** The first line of `s` (marked's line loops read src one line at a time). */
function firstLineOf(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

/** Expand a line's leading tabs, when it has any leading whitespace at all. */
function expandLead(line, indent) {
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return line;
  return line.replace(other.leadingSpaceTab, (whitespace) =>
    whitespace.includes('\t') ? expandTabs(whitespace, indent) : whitespace);
}

/**
 * Does `line` begin a block that ends a list item at this indent? One
 * first-character gate in front of the six begin rules: each rule needs
 * its own opening character after at most `indent` spaces, so a line
 * whose first significant character fits none of them fits none of them.
 */
function blockBegin(line, indent, fencesRe, headingRe, htmlRe, quoteRe, bulletRe, hrRe2) {
  let sp = 0;
  while (line.charCodeAt(sp) === 32) sp++;
  if (sp > indent) return false;
  const fc = line[sp];
  if (fc === '`' || fc === '~') return fencesRe.test(line);
  if (fc === '#') return headingRe.test(line);
  if (fc === '<') return htmlRe.test(line);
  if (fc === '>') return quoteRe !== null && quoteRe.test(line);
  if (fc === '*' || fc === '+' || fc === '-' || fc === '_' || (fc >= '0' && fc <= '9')) {
    if (bulletRe !== null && fc !== '_' && bulletRe.test(line)) return true;
    return (fc === '-' || fc === '_' || fc === '*') && hrRe2.test(line);
  }
  return false;
}

function tokList(S, src) {
  let cap = listRule.exec(src);
  if (!cap) return;
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;
  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (hrRule.test(src)) break;

    const itemStart = taken();
    src = src.substring(cap[0].length);

    const firstLine = firstLineOf(cap[2]);
    const bulletIndent = cap[1].length;
    let line = expandLead(firstLine, bulletIndent);
    let nextLine = firstLineOf(src);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(other.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && other.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRe = nextBulletRegex(indent);
      const hrRe = hrBeginRegex(indent);
      const fencesBeginRe = fencesBeginRegex(indent);
      const headingBeginRe = headingBeginRegex(indent);
      const htmlBeginRe = htmlBeginRegex(indent);
      const blockquoteBeginRe = blockquoteBeginRegex(indent);

      while (src) {
        const rawLine = firstLineOf(src);
        let nextLineWithoutTabs;
        nextLine = rawLine;
        nextLineWithoutTabs = expandLead(nextLine, 0);

        if (blockBegin(nextLine, indent, fencesBeginRe, headingBeginRe, htmlBeginRe, blockquoteBeginRe, nextBulletRe, hrRe)) break;

        if (nextLineWithoutTabs.search(other.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if ((line.includes('\t') ? line.replace(/\t/g, '    ') : line).search(other.nonSpaceChar) >= 4) break;
          if (blockBegin(line, indent, fencesBeginRe, headingBeginRe, htmlBeginRe, null, null, hrRe)) break;

          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && lheadingRule.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      if (endsWithBlankLine) {
        list.loose = true;
      } else if (other.doubleBlankLine.test(raw)) {
        endsWithBlankLine = true;
      }
    }

    list.items.push({
      raw,
      task: other.listIsTask.test(itemContents),
      text: itemContents,
      tokens: [],
      checkbox: null,
      checkboxLoose: false,
    });
  }

  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  for (const item of list.items) {
    S.top = false;
    item.tokens = blockTokens(S, item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.t === 'text' || itemToken?.t === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      let queueTarget = null;
      for (let i = S.inlineQueue.length - 1; i >= 0; i--) {
        if (other.listIsTask.test(S.inlineQueue[i].text)) {
          queueTarget = S.inlineQueue[i];
          break;
        }
      }
      if (queueTarget && queueTarget !== itemToken) {
        queueTarget.text = queueTarget.text.replace(other.listReplaceTask, '');
      }
      itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(other.listReplaceTask, '');

      const taskRaw = other.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        item.checkbox = { checked: taskRaw[0] !== '[ ]' };
        item.checkboxLoose = list.loose;
        item.checkboxTarget = itemToken;
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      for (const token of item.tokens) {
        if (token.t === 'text') token.t = 'paragraph';
      }
    }
  }

  return list;
}

function tokHtml(src) {
  const cap = htmlBlockRule.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { t: 'html', raw, text: raw };
  }
}

function tokDef(src) {
  const cap = defRule.exec(src);
  if (cap) {
    if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
      return;
    }
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuation, '$1') : cap[3];
    return { t: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokTable(S, src) {
  const cap = tableRule.exec(src);
  if (!cap) return;
  if (!other.tableDelimiter.test(cap[2])) return;

  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];

  if (headers.length !== aligns.length) return;

  const align = [];
  for (const a of aligns) {
    if (other.tableAlignRight.test(a)) align.push('right');
    else if (other.tableAlignCenter.test(a)) align.push('center');
    else if (other.tableAlignLeft.test(a)) align.push('left');
    else align.push(null);
  }

  const header = [];
  for (let i = 0; i < headers.length; i++) {
    const cell = { text: headers[i], align: align[i], header: true };
    S.inlineQueue.push(cell);
    header.push(cell);
  }
  const bodyRows = [];
  for (const row of rows) {
    const cells = splitCells(row, header.length).map((cellText, i) => {
      const cell = { text: cellText, align: align[i], header: false };
      S.inlineQueue.push(cell);
      return cell;
    });
    bodyRows.push(cells);
  }

  return { t: 'table', raw: rtrim(cap[0], '\n'), header, align, rows: bodyRows };
}

function tokLheading(S, src) {
  const cap = lheadingRule.exec(src);
  if (cap) {
    const node = {
      t: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text: cap[1].trim(),
    };
    S.inlineQueue.push(node);
    return node;
  }
}

function tokParagraph(S, src) {
  const cap = paragraphRule.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    const node = { t: 'paragraph', raw: cap[0], text };
    S.inlineQueue.push(node);
    return node;
  }
}

function tokText(S, src) {
  const cap = blockTextRule.exec(src);
  if (cap) {
    const node = { t: 'text', raw: cap[0], text: cap[0] };
    S.inlineQueue.push(node);
    return node;
  }
}

/**
 * Cheap necessary-condition gates for the expensive block rules. Each one
 * only skips a rule whose regex could not match anyway (its outcome is
 * unchanged); the rule itself always has the last word.
 */
function setextPossible(src) {
  let pos = 0;
  while (pos < src.length) {
    let eol = src.indexOf('\n', pos);
    if (eol === -1) eol = src.length;
    const line = src.slice(pos, eol);
    if (/^[ \t]*$/.test(line)) return false;
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) return true;
    pos = eol + 1;
  }
  return false;
}

function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let end = src.indexOf('\n', nl + 1);
  if (end === -1) end = src.length;
  const line2 = src.slice(nl + 1, end);
  return /^[ \t]*[|:-][ \t|:-]*$/.test(line2)
    && line2.includes('-')
    && (line2.includes('|') || line2.includes(':'));
}

function blockTokens(S, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    let token;

    if ((token = tokSpace(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // First significant character of the block, for the gates below.
    let lead = 0;
    while (src.charCodeAt(lead) === 32) lead++;
    const fc = src[lead];
    const fcOk = lead <= 3;

    if ((src.charCodeAt(0) === 32 || src.charCodeAt(0) === 9) && (token = tokCode(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.t === 'paragraph' || lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (fcOk && (fc === '`' || fc === '~') && (token = tokFences(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (fcOk && fc === '#' && (token = tokHeading(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (fcOk && (fc === '-' || fc === '_' || fc === '*') && (token = tokHr(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (fcOk && fc === '>' && (token = tokBlockquote(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (fcOk && (fc === '*' || fc === '+' || fc === '-' || (fc >= '0' && fc <= '9')) && (token = tokList(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (fcOk && fc === '<' && (token = tokHtml(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (fcOk && fc === '[' && (token = tokDef(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.t === 'paragraph' || lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
      } else {
        if (!Object.hasOwn(S.links, token.tag)) {
          S.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }

    if (tablePossible(src) && (token = tokTable(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (setextPossible(src) && (token = tokLheading(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (S.top && (token = tokParagraph(S, src))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.t === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.inlineQueue.pop();
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }

    if ((token = tokText(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.inlineQueue.pop();
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  S.top = true;
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Inline phase. scanInline renders one inline run straight to HTML
 * (and, when wantText is set, to the flattened text the image renderer
 * needs for alt attributes). Nested runs (emphasis content, link
 * labels) recurse through scanInline itself.
 * ------------------------------------------------------------------ */

const urlBackpedalRule = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

/** One sweep: last index of a `*` / `_` / `~` run that could close a span. */
function scanClosers(maskedSrc) {
  const last = { star: -1, und: -1, tilde: -1 };
  const len = maskedSrc.length;
  for (let i = 0; i < len; i++) {
    const ch = maskedSrc[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : maskedSrc[i - 1];
    let j = i + 1;
    while (j < len && maskedSrc[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') last.tilde = i;
      else if (ch === '*') last.star = i;
      else last.und = i;
    }
    i = j - 1;
  }
  return last;
}

/** Does this link text hold a link already? (Images do not count.) */
function linkInText(S, text) {
  if (!text.includes('[')) return false;
  blockSkipRule.lastIndex = 0;
  for (const match of text.matchAll(blockSkipRule)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  reflinkSearchRule.lastIndex = 0;
  for (const match of text.matchAll(reflinkSearchRule)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(S, match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Mask links, code spans, HTML and escapes in a copy of the source so the
 * emphasis scanners never see delimiters inside them. Every replacement
 * keeps the length it replaces, so masked and raw stay index-aligned.
 */
function maskSrc(S, src) {
  let maskedSrc = src;

  if (src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(S, text)) {
          return '[' + text.replace(reflinkSearchRule, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearchRule, maskReflink);
  }

  maskedSrc = maskedSrc.replace(anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) {
      return '+'.repeat(match0.length);
    }
    if (code) {
      return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    }
    return match0;
  });

  maskedSrc = maskedSrc.replace(blockSkipRule, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });

  return maskedSrc;
}

function renderLinkTag(href, title, innerHtml, autolink) {
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    return innerHtml;
  }
  let out = '<a href="' + escapeHtmlEntities(cleanHref, autolink) + '"';
  if (title) {
    out += ' title="' + escapeHtmlEntities(title) + '"';
  }
  out += '>' + innerHtml + '</a>';
  return out;
}

function renderImageTag(href, title, altText) {
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    return escapeHtmlEntities(altText);
  }
  let out = `<img src="${escapeHtmlEntities(cleanHref)}" alt="${escapeHtmlEntities(altText)}"`;
  if (title) {
    out += ` title="${escapeHtmlEntities(title)}"`;
  }
  out += '>';
  return out;
}

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

/**
 * A matched link or image: lex its label (recursively), apply the
 * no-link-inside-a-link rule, and render. Returns {len, html, text} or
 * null when the label itself holds a link (the caller falls through and
 * the inner link is the one kept).
 */
function outputLink(S, cap, link, raw, wantText) {
  const href = link.href;
  const title = link.title || null;
  const labelText = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const inner = scanInline(S, labelText, wantText || isImage);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;

  if (!isImage) {
    if (textHasLink) {
      S.inRawBlock = outerInRawBlock;
      return null;
    }
    S.linkEmitted = true;
  }

  if (isImage) {
    return { len: raw.length, html: renderImageTag(href, title, inner.text ?? ''), text: inner.text ?? '' };
  }
  return { len: raw.length, html: renderLinkTag(href, title, inner.html, false), text: inner.text ?? '' };
}

function tokLink(S, src, wantText) {
  if (S.linkParenPossible === false) return null;
  const cap = linkRule.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;

  let href = cap[2];
  let raw = cap[0];
  let title = cap[3];
  const trimmedUrl = href.trim();
  if (other.startAngleBracket.test(trimmedUrl)) {
    if (!other.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(href, '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = raw.indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      href = href.substring(0, lastParenIndex);
      raw = raw.substring(0, linkLen).trim();
      title = '';
    }
  }
  const unescaped = rtrim(raw.slice(0, -1), '\\');
  if ((raw.length - unescaped.length) % 2 === 0) return null;

  title = title ? title.slice(1, -1) : '';
  href = href.trim();
  if (other.startAngleBracket.test(href)) {
    href = href.slice(1, -1);
  }
  return outputLink(S, cap, {
    href: href ? href.replace(anyPunctuation, '$1') : href,
    title: title ? title.replace(anyPunctuation, '$1') : title,
  }, raw, wantText);
}

function tokReflink(S, src, wantText) {
  let cap;
  if ((cap = reflinkRule.exec(src)) || (cap = nolinkRule.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
    const link = S.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { len: 1, textToken: text };
    }
    return outputLink(S, cap, link, cap[0], wantText);
  }
  return null;
}

function tokEmStrong(S, src, maskedSrc, prevChar, ctx, wantText) {
  let match = emStrongLDelimRule.exec(src);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;

  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
    runStart--;
  }
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!punctuationRule.exec(runPrevChar);
  if (runStart < srcStart) {
    prevChar = runPrevChar;
  }
  const prevPunct = runStart < srcStart ? runPrevPunct : !!punctuationRule.exec(prevChar);

  if (match[4] && prevChar.match(other.unicodeAlphaNumeric)) return null;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? emStrongRDelimAstRule : emStrongRDelimUndRule;
    const lastPossibleCloserIndex = delimChar === '*' ? ctx.star : ctx.und;
    const closerWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleCloserIndex < closerWindowStart) return null;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleCloserIndexInWindow = lastPossibleCloserIndex - closerWindowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;

      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) {
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = scanInline(S, text, wantText);
        return { len: raw.length, html: `<em>${inner.html}</em>`, text: inner.text ?? '' };
      }
      const text = raw.slice(2, -2);
      const inner = scanInline(S, text, wantText);
      return { len: raw.length, html: `<strong>${inner.html}</strong>`, text: inner.text ?? '' };
    }
  }
  return null;
}

function tokDel(S, src, maskedSrc, prevChar, ctx, wantText) {
  let match = delLDelimRule.exec(src);
  if (!match) return null;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || punctuationRule.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;

    const endReg = delRDelimRule;
    const lastPossibleCloserIndex = ctx.tilde;
    const closerWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleCloserIndex < closerWindowStart) return null;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleCloserIndexInWindow = lastPossibleCloserIndex - closerWindowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const inner = scanInline(S, text, wantText);
      return { len: raw.length, html: `<del>${inner.html}</del>`, text: inner.text ?? '' };
    }
  }
  return null;
}

const emailHeadRe = /[A-Za-z0-9.!#$%&'*+\/=?_`{|}~-]+@/y;

function isAlnumChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** The GFM extended-autolink character set, for text-run stop checks. */
function isEmailChar(ch) {
  if (isAlnumChar(ch)) return true;
  switch (ch) {
    case '.': case '!': case '#': case '$': case '%': case '&': case "'":
    case '*': case '+': case '/': case '=': case '?': case '^': case '_':
    case '`': case '{': case '|': case '}': case '~': case '-':
      return true;
    default:
      return false;
  }
}

/**
 * Length of the plain-text run starting at `rest` — the same span marked's
 * GFM text rule covers, found by one character sweep instead of the rule's
 * lookahead cascade. The run ends exactly where another inline rule could
 * start: at a special character, before a hard break's spaces, and before
 * an extended autolink (www., protocol://, mailto:/xmpp:, or an email
 * address after a character that cannot be part of one). Ending a run a
 * little early is harmless — the following text run simply continues it —
 * so every stop the rule has is reproduced.
 */
/** http://, https:// or ftp:// at position i, case-insensitive, no slicing. */
function startsProtocol(rest, i) {
  const c1 = rest.charCodeAt(i) | 32;
  if (c1 === 104) { // h
    if ((rest.charCodeAt(i + 1) | 32) !== 116 || (rest.charCodeAt(i + 2) | 32) !== 116
      || (rest.charCodeAt(i + 3) | 32) !== 112) return false;
    let j = i + 4;
    if ((rest.charCodeAt(j) | 32) === 115) j++;
    return rest.charCodeAt(j) === 58 && rest.charCodeAt(j + 1) === 47 && rest.charCodeAt(j + 2) === 47;
  }
  if (c1 === 102) { // f
    return (rest.charCodeAt(i + 1) | 32) === 116 && (rest.charCodeAt(i + 2) | 32) === 112
      && rest.charCodeAt(i + 3) === 58 && rest.charCodeAt(i + 4) === 47 && rest.charCodeAt(i + 5) === 47;
  }
  return false;
}

function textRunLength(rest, hasAt) {
  const n = rest.length;
  let i = 1;
  // A backtick or tilde run the code/del rule just refused is swallowed
  // whole as the run's head (marked's text rule opens with `+ or ~+), so
  // the span rules are never retried inside the run.
  const c0 = rest.charCodeAt(0);
  if (c0 === 96 || c0 === 126) {
    while (i < n && rest.charCodeAt(i) === c0) i++;
  }
  // Right after the head, an email pattern ends the run with no condition
  // on the head character (the text rule's own (?=email) alternative).
  if (hasAt) {
    emailHeadRe.lastIndex = i;
    if (emailHeadRe.test(rest)) return i;
  }
  while (i < n) {
    const c = rest.charCodeAt(i);
    if (c === 92 || c === 60 || c === 33 || c === 91 || c === 96 || c === 42 || c === 126 || c === 95) {
      break; // \ < ! [ ` * ~ _
    }
    const prev = rest[i - 1];
    if (c === 32) {
      // a hard break: the run ends after a non-space, before 2+ spaces + \n
      if (prev !== ' ') {
        let j = i;
        while (j < n && rest.charCodeAt(j) === 32) j++;
        if (j - i >= 2 && rest.charCodeAt(j) === 10) break;
      }
      i++;
      continue;
    }
    if ((c === 119 || c === 87) && rest.startsWith('www.', i)
      && (prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f'
        || prev === '\v' || prev === '*' || prev === '_' || prev === '~' || prev === '(')) {
      break;
    }
    if ((c === 104 || c === 72 || c === 102 || c === 70) && startsProtocol(rest, i)) {
      break;
    }
    if ((c === 109 || c === 120) && !isAlnumChar(prev)
      && (rest.startsWith('mailto:', i) || rest.startsWith('xmpp:', i))) {
      break;
    }
    if (hasAt && !isEmailChar(prev)) {
      emailHeadRe.lastIndex = i;
      if (emailHeadRe.test(rest)) break;
    }
    i++;
  }
  return i;
}

function scanInline(S, src, wantText = false) {
  const prevLinkParenPossible = S.linkParenPossible;
  S.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    const hasDelims = src.includes('*') || src.includes('_') || src.includes('~');
    const maskedSrc = hasDelims ? maskSrc(S, src) : src;
    const ctx = hasDelims ? scanClosers(maskedSrc) : { star: -1, und: -1, tilde: -1 };
    ctx.maskedSrc = maskedSrc;
    const runHasAt = src.includes('@');

    let html = '';
    let text = '';
    let keepPrevChar = false;
    let prevChar = '';
    let rest = src;
    let guard = Infinity;

    const emitText = (rawText) => {
      if (S.inRawBlock) {
        html += rawText;
        if (wantText) text += rawText;
      } else {
        const decoded = decodeNumericCharacterReferences(rawText);
        html += escapeHtmlEntities(decoded);
        if (wantText) text += decoded;
      }
    };

    while (rest) {
      if (rest.length < guard) {
        guard = rest.length;
      } else {
        throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      }
      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;

      const c0 = rest.charCodeAt(0);
      let tok = null;

      // escape
      if (c0 === 92) { // backslash
        const cap = escapeRule.exec(rest);
        if (cap) {
          html += escapeHtmlEntities(cap[1]);
          if (wantText) text += cap[1];
          rest = rest.slice(cap[0].length);
          continue;
        }
      }

      // tag
      if (c0 === 60) { // <
        const cap = tagRule.exec(rest);
        if (cap) {
          if (!S.inLink && other.startATag.test(cap[0])) {
            S.inLink = true;
          } else if (S.inLink && other.endATag.test(cap[0])) {
            S.inLink = false;
          }
          if (!S.inRawBlock && other.startPreScriptTag.test(cap[0])) {
            S.inRawBlock = true;
          } else if (S.inRawBlock && other.endPreScriptTag.test(cap[0])) {
            S.inRawBlock = false;
          }
          html += cap[0];
          if (wantText) text += cap[0];
          rest = rest.slice(cap[0].length);
          continue;
        }
      }

      // link, then reflink / nolink
      if (c0 === 91 || (c0 === 33 && rest.charCodeAt(1) === 91)) { // [ or ![
        tok = tokLink(S, rest, wantText);
        if (!tok) tok = tokReflink(S, rest, wantText);
        if (tok) {
          if (tok.textToken !== undefined) {
            emitText(tok.textToken);
          } else {
            html += tok.html;
            if (wantText) text += tok.text;
          }
          rest = rest.slice(tok.len);
          continue;
        }
      }

      // em & strong (only when a possible closer exists ahead in the run)
      if ((c0 === 42 && ctx.star >= ctx.maskedSrc.length - rest.length + 1)
        || (c0 === 95 && ctx.und >= ctx.maskedSrc.length - rest.length + 1)) {
        tok = tokEmStrong(S, rest, ctx.maskedSrc, prevChar, ctx, wantText);
        if (tok) {
          html += tok.html;
          if (wantText) text += tok.text;
          rest = rest.slice(tok.len);
          continue;
        }
      }

      // codespan
      if (c0 === 96) { // `
        const cap = inlineCodeRule.exec(rest);
        if (cap) {
          let codeText = cap[2].replace(/\n/g, ' ');
          const hasNonSpaceChars = /[^ ]/.test(codeText);
          const hasSpaceCharsOnBothEnds = /^ /.test(codeText) && / $/.test(codeText);
          if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
            codeText = codeText.substring(1, codeText.length - 1);
          }
          html += `<code>${escapeHtmlEntities(codeText, true)}</code>`;
          if (wantText) text += codeText;
          rest = rest.slice(cap[0].length);
          continue;
        }
      }

      // br (a backslash the escape rule did not take, or 2+ spaces, before \n)
      if (c0 === 92 || c0 === 32) {
        const cap = brRule.exec(rest);
        if (cap) {
          html += '<br>';
          rest = rest.slice(cap[0].length);
          continue;
        }
      }

      // del (gfm)
      if (c0 === 126 && ctx.tilde >= ctx.maskedSrc.length - rest.length + 1) { // ~
        tok = tokDel(S, rest, ctx.maskedSrc, prevChar, ctx, wantText);
        if (tok) {
          html += tok.html;
          if (wantText) text += tok.text;
          rest = rest.slice(tok.len);
          continue;
        }
      }

      // autolink
      if (c0 === 60) {
        const cap = autolinkRule.exec(rest);
        if (cap) {
          let linkText, href;
          if (cap[2] === '@') {
            linkText = cap[1];
            href = 'mailto:' + linkText;
          } else {
            linkText = cap[1];
            href = linkText;
          }
          html += renderLinkTag(href, null, escapeHtmlEntities(linkText, true), true);
          if (wantText) text += linkText;
          rest = rest.slice(cap[0].length);
          continue;
        }
      }

      // url (gfm extended autolink)
      if (!S.inLink && ((c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) {
        const cap = urlRule.exec(rest);
        if (cap) {
          let linkText, href;
          if (cap[2] === '@') {
            linkText = cap[0];
            href = 'mailto:' + linkText;
          } else {
            let prevCapZero;
            let whole = cap[0];
            do {
              prevCapZero = whole;
              whole = urlBackpedalRule.exec(whole)?.[0] ?? '';
            } while (prevCapZero !== whole);
            linkText = whole;
            href = cap[1] === 'www.' ? 'http://' + whole : whole;
          }
          html += renderLinkTag(href, null, escapeHtmlEntities(linkText, true), true);
          if (wantText) text += linkText;
          rest = rest.slice(linkText.length);
          continue;
        }
      }

      // text
      const len = textRunLength(rest, runHasAt);
      const piece = rest.slice(0, len);
      emitText(piece);
      // marked tracks the previous character per text token, and a token
      // ending in '_' leaves it alone; over a whole run that is the run's
      // last character that is not '_', if it has one.
      for (let k = len - 1; k >= 0; k--) {
        if (piece[k] !== '_') {
          prevChar = piece[k];
          break;
        }
      }
      keepPrevChar = true;
      rest = rest.slice(len);
      continue;
    }

    return { html, text: wantText ? text : null };
  } finally {
    S.linkParenPossible = prevLinkParenPossible;
  }
}

/** Render one queued inline source (a block's text or a table cell). */
function renderQueuedInline(S, src) {
  S.inRawBlock = false;
  return scanInline(S, src, false).html;
}

/* ------------------------------------------------------------------ *
 * Rendering: block nodes to HTML (marked's src/Renderer.ts output).
 * Inline sources render here, in document order, after the block
 * phase has collected every link definition.
 * ------------------------------------------------------------------ */

function renderTableCell(S, cell) {
  const content = renderQueuedInline(S, cell.text);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderList(S, node) {
  let body = '';
  for (const item of node.items) {
    body += renderListItem(S, item);
  }
  const type = node.ordered ? 'ol' : 'ul';
  const startAttr = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
  return `<${type}${startAttr}>\n${body}</${type}>\n`;
}

function renderListItem(S, item) {
  let inner = '';
  let prependNode = null;
  let prependHtml = '';
  if (item.checkbox) {
    if (item.checkboxLoose) {
      // the checkbox rides inside the first paragraph's inline content
      prependNode = item.checkboxTarget;
      prependHtml = checkboxHtml(item.checkbox.checked);
    } else {
      inner += checkboxHtml(item.checkbox.checked);
    }
  }
  inner += renderBlocks(S, item.tokens, prependNode, prependHtml);
  return `<li>${inner}</li>\n`;
}

function renderBlocks(S, tokens, prependNode = null, prependHtml = '') {
  let out = '';
  for (const node of tokens) {
    switch (node.t) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${node.depth}>${renderQueuedInline(S, node.text)}</h${node.depth}>\n`;
        break;
      case 'code': {
        const langString = (node.lang || '').match(/^\S*/)?.[0];
        const code = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
        if (!langString) {
          out += '<pre><code>' + escapeHtmlEntities(code, true) + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-'
            + escapeHtmlEntities(langString)
            + '">'
            + escapeHtmlEntities(code, true)
            + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let cell = '';
        for (const c of node.header) cell += renderTableCell(S, c);
        const header = `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (const row of node.rows) {
          cell = '';
          for (const c of row) cell += renderTableCell(S, c);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(S, node.tokens)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(S, node);
        break;
      case 'html':
        out += node.text;
        break;
      case 'def':
        break;
      case 'paragraph': {
        const inner = renderQueuedInline(S, node.text);
        out += node === prependNode
          ? `<p>${prependHtml}${inner}</p>\n`
          : `<p>${inner}</p>\n`;
        break;
      }
      case 'text':
        out += renderQueuedInline(S, node.text);
        break;
      default:
        throw new Error('Token with "' + node.t + '" type was not found.');
    }
  }
  return out;
}

/**
 * The HTML marked 18.1.3 renders for `markdown`, with marked's defaults
 * (gfm: true, breaks: false, pedantic: false, async: false).
 */
export function parse(markdown) {
  const S = {
    links: Object.create(null),
    inlineQueue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const src = markdown.replace(other.carriageReturn, '\n');
  const tokens = blockTokens(S, src, []);
  return renderBlocks(S, tokens);
}
