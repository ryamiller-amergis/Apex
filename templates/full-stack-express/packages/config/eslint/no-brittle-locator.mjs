const BANNED_CALLEES = new Set(['locator', '$', '$$', '$x']);

function calleeName(node) {
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier'
  ) {
    return node.property.name;
  }
  return null;
}

function literalText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? '';
  }
  return null;
}

function isBrittle(value) {
  const text = value.trim();
  return (
    text.startsWith('.') ||
    text.startsWith('#') ||
    text.startsWith('//') ||
    text.startsWith('xpath=') ||
    text.startsWith('id=') ||
    text.startsWith('css=')
  );
}

const noBrittleLocator = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ban CSS-class, id, and XPath locators in end-to-end specs',
    },
    schema: [],
    messages: {
      banned:
        'Use a role, label, or data-testid selector. CSS-class, id, and XPath locators are banned.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || !BANNED_CALLEES.has(name)) {
          return;
        }
        const first = node.arguments[0];
        if (!first) {
          return;
        }
        const text = literalText(first);
        if (text !== null && isBrittle(text)) {
          context.report({ node: first, messageId: 'banned' });
        }
      },
    };
  },
};

export default noBrittleLocator;
