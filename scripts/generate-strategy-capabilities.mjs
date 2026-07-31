import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const indicatorRegistryPath = resolve(projectRoot, 'src/features/indicators/registry.ts');
const dslTypesPath = resolve(projectRoot, 'src/features/visualStrategies/types.ts');
const outputPath = resolve(
  projectRoot,
  'server/src/services/strategyGeneration/generatedIndicatorCapabilities.ts',
);
const checkOnly = process.argv.includes('--check');

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw new Error(`Unsupported property-name node: ${ts.SyntaxKind[node.kind]}`);
}

function evaluateLiteral(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text);
    return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(evaluateLiteral);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(node.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`Indicator registry contains an unsupported property: ${property.getText()}`);
      }
      return [propertyName(property.name), evaluateLiteral(property.initializer)];
    }));
  }
  if (
    ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node)
    || ts.isParenthesizedExpression(node)
  ) {
    return evaluateLiteral(node.expression);
  }
  throw new Error(`Indicator registry contains an unsupported expression: ${node.getText()}`);
}

function stringLiteralUnion(typeNode) {
  const nodes = ts.isUnionTypeNode(typeNode) ? typeNode.types : [typeNode];
  return nodes.map((node) => {
    if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) {
      throw new Error(`Expected a string-literal union, received: ${node.getText()}`);
    }
    return node.literal.text;
  });
}

function collectRiskRuleTypes(typeNode) {
  const values = [];
  function visit(node) {
    if (
      ts.isPropertySignature(node)
      && node.name
      && propertyName(node.name) === 'type'
      && node.type
    ) {
      values.push(...stringLiteralUnion(node.type));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(typeNode);
  return [...new Set(values)];
}

async function readDslCapabilities() {
  const sourceText = await readFile(dslTypesPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    dslTypesPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const aliases = new Map();
  sourceFile.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type);
  });
  const requiredAlias = (name) => {
    const value = aliases.get(name);
    if (!value) throw new Error(`Missing DSL type alias: ${name}`);
    return value;
  };
  return {
    marketFields: stringLiteralUnion(requiredAlias('MarketField')),
    accountFields: stringLiteralUnion(requiredAlias('AccountField')),
    compareOperators: stringLiteralUnion(requiredAlias('CompareOperator')),
    riskRuleTypes: collectRiskRuleTypes(requiredAlias('RiskRule')),
  };
}

async function buildIndicatorCapabilities() {
  const sourceText = await readFile(indicatorRegistryPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    indicatorRegistryPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let initializer;
  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === 'INDICATOR_REGISTRY'
      ) {
        initializer = declaration.initializer;
      }
    }
  });
  if (!initializer) throw new Error('INDICATOR_REGISTRY was not found');
  const registry = evaluateLiteral(initializer);
  if (!Array.isArray(registry)) throw new Error('INDICATOR_REGISTRY must be an array');

  return registry.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each indicator definition must be an object');
    }
    const params = Array.isArray(entry.params) ? entry.params : [];
    const display = entry.display && typeof entry.display === 'object' && !Array.isArray(entry.display)
      ? entry.display : {};
    const series = Array.isArray(display.series) ? display.series : [];
    return {
      id: String(entry.id),
      name: String(entry.name),
      params: params.map((param) => ({
        name: String(param.name),
        label: String(param.label),
        defaultValue: Number(param.defaultValue),
        min: Number(param.min),
        max: Number(param.max),
        step: Number(param.step),
      })),
      outputs: [...new Map(series.map((output) => [
        String(output.key),
        { key: String(output.key), label: String(output.label) },
      ])).values()],
    };
  });
}

const [indicatorCapabilities, dslCapabilities] = await Promise.all([
  buildIndicatorCapabilities(),
  readDslCapabilities(),
]);
const generated = `// Generated by scripts/generate-strategy-capabilities.mjs. Do not edit by hand.
// Sources: src/features/indicators/registry.ts and src/features/visualStrategies/types.ts
export const GENERATED_VISUAL_INDICATOR_CAPABILITIES = ${JSON.stringify(indicatorCapabilities, null, 2)} as const;

export const GENERATED_MARKET_FIELDS = ${JSON.stringify(dslCapabilities.marketFields)} as const;
export const GENERATED_ACCOUNT_FIELDS = ${JSON.stringify(dslCapabilities.accountFields)} as const;
export const GENERATED_COMPARE_OPERATORS = ${JSON.stringify(dslCapabilities.compareOperators)} as const;
export const GENERATED_RISK_RULE_TYPES = ${JSON.stringify(dslCapabilities.riskRuleTypes)} as const;
`;

if (checkOnly) {
  let current = '';
  try {
    current = await readFile(outputPath, 'utf8');
  } catch {
    // The error below explains how to generate the missing artifact.
  }
  if (current !== generated) {
    console.error('Generated strategy capabilities are stale. Run npm run capabilities:generate.');
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, generated, 'utf8');
  console.log(`Generated ${indicatorCapabilities.length} indicator capabilities: ${outputPath}`);
}
