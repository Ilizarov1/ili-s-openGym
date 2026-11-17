const { findVariable, getPropertyName, getStaticValue } = require('@eslint-community/eslint-utils');

const textComponents = new Set(['Text', 'RNText', 'Animated.Text', 'TSpan', 'Button', 'Chip', 'Badge']);
const styleProps = new Set(['style', 'contentContainerStyle', 'columnWrapperStyle']);
const checkboxStates = new Set([true, false, 'mixed']);
const colorProperty = /^(?:color|[a-z]\w*Color)$/;
const lengthProperty = /^(?:(?:margin|padding)(?:[A-Z]\w*)?|(?:rowGap|columnGap|gap)|border\w*Radius|fontSize)$/;

function definitionOf(node, sourceCode) {
  if (node.type !== 'Identifier') return undefined;
  const definitions = findVariable(sourceCode.getScope(node), node)?.defs;
  return definitions?.length === 1 ? definitions[0] : undefined;
}

function isFunction(node) {
  return /^(?:ArrowFunctionExpression|FunctionExpression|FunctionDeclaration)$/.test(node.type);
}

// Visit possible values in this file without evaluating application code.
function visitValues(node, sourceCode, visit, seen = new Set()) {
  if (!node || seen.has(node)) return;
  seen.add(node);
  const visitChild = child => visitValues(child, sourceCode, visit, seen);
  switch (node.type) {
    case 'ArrayExpression':
      node.elements.forEach(visitChild);
      break;
    case 'ConditionalExpression':
      visitChild(node.consequent);
      visitChild(node.alternate);
      break;
    case 'LogicalExpression':
      if (node.operator !== '&&') visitChild(node.left);
      visitChild(node.right);
      break;
    case 'SpreadElement':
      visitChild(node.argument);
      break;
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
      visitChild(node.expression);
      break;
    case 'Identifier': {
      const definition = definitionOf(node, sourceCode);
      if (definition?.type === 'Variable' && definition.parent.kind === 'const' && definition.node.id.type === 'Identifier') {
        visitChild(definition.node.init);
      } else if (definition?.type === 'FunctionName') {
        visitChild(definition.node);
      } else {
        visit(node);
      }
      break;
    }
    default:
      visit(node);
  }
}

function returnedValues(node, sourceCode, visit) {
  if (!node || isFunction(node)) return;
  if (node.type === 'ReturnStatement') {
    visit(node.argument);
    return;
  }
  for (const key of sourceCode.visitorKeys[node.type] ?? []) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach(value => returnedValues(value, sourceCode, visit));
    else returnedValues(child, sourceCode, visit);
  }
}

function elementName(name) {
  return name.type === 'JSXMemberExpression'
    ? `${elementName(name.object)}.${name.property.name}`
    : name.name;
}

function hasTextParent(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'JSXElement') return textComponents.has(elementName(parent.openingElement.name));
    if (parent.type === 'JSXAttribute' || isFunction(parent)) return false;
  }
  return false;
}

function jsxValue(attribute) {
  return attribute?.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : attribute?.value;
}

const noRawText = {
  meta: {
    schema: [],
    messages: { wrap: 'Render text and numbers inside Text or a design component that wraps its children in Text.' },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      JSXText(node) {
        if (!hasTextParent(node) && (node.value.trim() || /^[ \t]+$/.test(node.value))) {
          context.report({ node, messageId: 'wrap' });
        }
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === 'JSXAttribute' || hasTextParent(node)) return;
        let raw = false;
        visitValues(node.expression, sourceCode, value => {
          if (raw) return;
          const constant = getStaticValue(value, sourceCode.getScope(value))?.value;
          raw = typeof constant === 'number' || (typeof constant === 'string' && constant !== '') ||
            (value.type === 'TemplateLiteral' && value.expressions.length > 0 && constant === undefined);
        });
        if (raw) context.report({ node, messageId: 'wrap' });
      },
    };
  },
};

const requireCheckboxState = {
  meta: {
    schema: [],
    messages: { missing: 'A checkbox needs accessibilityState.checked to announce its state.' },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      JSXOpeningElement(node) {
        const props = node.attributes.filter(attribute => attribute.type === 'JSXAttribute');
        const role = jsxValue(props.find(attribute => attribute.name.name === 'accessibilityRole'));
        if (!role || getStaticValue(role, sourceCode.getScope(role))?.value !== 'checkbox') return;

        const state = jsxValue(props.find(attribute => attribute.name.name === 'accessibilityState'));
        let missing = !state;
        visitValues(state, sourceCode, value => {
          if (value.type === 'ObjectExpression') {
            const scope = sourceCode.getScope(value);
            const checked = value.properties.find(property => getPropertyName(property, scope) === 'checked');
            if (checked) {
              const checkedValue = getStaticValue(checked.value, scope);
              missing ||= checkedValue !== null && !checkboxStates.has(checkedValue.value);
            } else {
              missing ||= !value.properties.some(property => property.type === 'SpreadElement');
            }
          } else {
            const stateValue = getStaticValue(value, sourceCode.getScope(value));
            missing ||= stateValue !== null && !checkboxStates.has(stateValue.value?.checked);
          }
        });
        if (missing) context.report({ node, messageId: 'missing' });
      },
    };
  },
};

const useDesignTokens = {
  meta: {
    schema: [],
    messages: { token: 'Use a design token for {{property}}.' },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const scannedStyles = new Set();
    const scannedSheets = new Set();

    function checkStyles(expression, sheet) {
      const scanned = sheet ? scannedSheets : scannedStyles;
      visitValues(expression, sourceCode, node => {
        if (scanned.has(node)) return;
        scanned.add(node);
        if (isFunction(node)) {
          if (node.body.type === 'BlockStatement') returnedValues(node.body, sourceCode, value => checkStyles(value, sheet));
          else checkStyles(node.body, sheet);
          return;
        }
        if (node.type !== 'ObjectExpression') return;
        const scope = sourceCode.getScope(node);
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') checkStyles(property.argument, sheet);
          else if (sheet) checkStyles(property.value, false);
          else {
            const name = getPropertyName(property, scope);
            const isColor = name && colorProperty.test(name);
            if (!name || (!isColor && !lengthProperty.test(name))) continue;
            let literal = false;
            visitValues(property.value, sourceCode, value => {
              const result = getStaticValue(value, sourceCode.getScope(value));
              if (!result) return;
              const { value: constant } = result;
              literal ||= isColor
                ? typeof constant === 'string' && constant !== 'transparent'
                : typeof constant === 'number' && (constant !== 0 || name === 'fontSize');
            });
            if (literal) context.report({ node: property, messageId: 'token', data: { property: name } });
          }
        }
      });
    }

    return {
      CallExpression(node) {
        const { callee } = node;
        const member = callee.type === 'MemberExpression';
        const definition = definitionOf(member ? callee.object : callee, sourceCode);
        if (definition?.type !== 'ImportBinding' || definition.node.type !== 'ImportSpecifier') return;
        const imported = definition.node.imported.name;
        if (member && imported === 'StyleSheet' && definition.parent.source.value === 'react-native' &&
          getPropertyName(callee, sourceCode.getScope(callee)) === 'create') {
          checkStyles(node.arguments[0], true);
        } else if (!member && imported === 'useThemedStyles') {
          checkStyles(node.arguments[0], true);
        }
      },
      JSXAttribute(node) {
        if (styleProps.has(node.name.name)) checkStyles(jsxValue(node), false);
      },
    };
  },
};

module.exports = {
  meta: { name: 'open-gym' },
  rules: {
    'no-raw-text': noRawText,
    'require-checkbox-state': requireCheckboxState,
    'use-design-tokens': useDesignTokens,
  },
};
