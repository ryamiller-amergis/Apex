const HEX_COLOR =
  /(^|[\s,(])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/i;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?)\(/i;

function isColorLiteral(text) {
  return HEX_COLOR.test(text) || COLOR_FUNCTION.test(text);
}

/**
 * Reports hex, rgb(), rgba(), hsl(), and hsla() colour literals. Colours come
 * from theme tokens. Named colours such as `red` are not detected.
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hard-coded colour literals; read colours from theme tokens',
    },
    schema: [],
    messages: {
      hardcodedColor:
        'Hard-coded colour "{{value}}". Use a theme token (packages/ui/src/tokens) or a token override instead.',
    },
  },
  create(context) {
    function report(node, value) {
      context.report({ node, messageId: 'hardcodedColor', data: { value } });
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string' && isColorLiteral(node.value)) {
          report(node, node.value);
        }
      },
      TemplateLiteral(node) {
        const text = node.quasis
          .map((quasi) => quasi.value.cooked ?? '')
          .join('${}');
        if (isColorLiteral(text)) {
          report(node, text);
        }
      },
    };
  },
};

export default rule;
