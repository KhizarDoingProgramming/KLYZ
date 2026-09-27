import { resolvePath, type DataScope } from "./expressions";
import { type ASTNode } from "./ast";

const MAX_DEPTH = 50;

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationError";
  }
}

export function evaluateAST(node: ASTNode, scope: DataScope, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    throw new EvaluationError("Expression too deep.");
  }

  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Path':
      return resolvePath(scope, node.path);
    case 'UnaryExpression': {
      const arg = evaluateAST(node.argument, scope, depth + 1);
      if (node.operator === '!') return !arg;
      if (node.operator === '-') {
        if (typeof arg !== 'number') throw new EvaluationError(`Cannot negate non-number: ${typeof arg}`);
        return -arg;
      }
      throw new EvaluationError(`Unknown unary operator: ${node.operator}`);
    }
    case 'BinaryExpression': {
      // Short-circuiting for && and ||
      if (node.operator === '&&') {
        const left = evaluateAST(node.left, scope, depth + 1);
        if (!left) return left;
        return evaluateAST(node.right, scope, depth + 1);
      }
      if (node.operator === '||') {
        const left = evaluateAST(node.left, scope, depth + 1);
        if (left) return left;
        return evaluateAST(node.right, scope, depth + 1);
      }

      const left = evaluateAST(node.left, scope, depth + 1);
      const right = evaluateAST(node.right, scope, depth + 1);

      switch (node.operator) {
        case '+':
          if (typeof left === 'number' && typeof right === 'number') return left + right;
          if (typeof left === 'string' || typeof right === 'string') return String(left) + String(right);
          throw new EvaluationError(`Cannot add ${typeof left} and ${typeof right}`);
        case '-':
          if (typeof left === 'number' && typeof right === 'number') return left - right;
          throw new EvaluationError(`Cannot subtract ${typeof left} and ${typeof right}`);
        case '*':
          if (typeof left === 'number' && typeof right === 'number') return left * right;
          throw new EvaluationError(`Cannot multiply ${typeof left} and ${typeof right}`);
        case '/':
          if (typeof left === 'number' && typeof right === 'number') {
            if (right === 0) throw new EvaluationError("Division by zero");
            return left / right;
          }
          throw new EvaluationError(`Cannot divide ${typeof left} and ${typeof right}`);
        case '%':
          if (typeof left === 'number' && typeof right === 'number') {
             if (right === 0) throw new EvaluationError("Modulo by zero");
             return left % right;
          }
          throw new EvaluationError(`Cannot modulo ${typeof left} and ${typeof right}`);
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case '>':
          if (typeof left === 'number' && typeof right === 'number') return left > right;
          if (typeof left === 'string' && typeof right === 'string') return left > right;
          return false;
        case '>=':
          if (typeof left === 'number' && typeof right === 'number') return left >= right;
          if (typeof left === 'string' && typeof right === 'string') return left >= right;
          return false;
        case '<':
          if (typeof left === 'number' && typeof right === 'number') return left < right;
          if (typeof left === 'string' && typeof right === 'string') return left < right;
          return false;
        case '<=':
          if (typeof left === 'number' && typeof right === 'number') return left <= right;
          if (typeof left === 'string' && typeof right === 'string') return left <= right;
          return false;
        default:
          throw new EvaluationError(`Unknown binary operator: ${node.operator}`);
      }
    }
    case 'FunctionCall': {
      const args = node.args.map(arg => evaluateAST(arg, scope, depth + 1));
      switch (node.name) {
        // String operations
        case 'lowercase':
          if (typeof args[0] !== 'string') throw new EvaluationError(`lowercase expects a string`);
          return args[0].toLowerCase();
        case 'uppercase':
          if (typeof args[0] !== 'string') throw new EvaluationError(`uppercase expects a string`);
          return args[0].toUpperCase();
        case 'trim':
          if (typeof args[0] !== 'string') throw new EvaluationError(`trim expects a string`);
          return args[0].trim();
        case 'length':
          if (typeof args[0] === 'string' || Array.isArray(args[0])) return args[0].length;
          throw new EvaluationError(`length expects a string or array`);
        case 'substring':
          if (typeof args[0] !== 'string') throw new EvaluationError(`substring expects a string`);
          return args[0].substring(Number(args[1]) || 0, Number(args[2]) || undefined);
        case 'replace':
          if (typeof args[0] !== 'string') throw new EvaluationError(`replace expects a string`);
          return args[0].replace(String(args[1]), String(args[2]));
        case 'concatenate':
          return args.map(String).join('');
        
        // Collection operations
        case 'contains':
          if (Array.isArray(args[0])) return args[0].includes(args[1]);
          if (typeof args[0] === 'string') return args[0].includes(String(args[1]));
          return false;
        case 'first':
          if (Array.isArray(args[0])) return args[0][0];
          throw new EvaluationError(`first expects an array`);
        case 'last':
          if (Array.isArray(args[0])) return args[0][args[0].length - 1];
          throw new EvaluationError(`last expects an array`);
        case 'empty':
          if (Array.isArray(args[0])) return args[0].length === 0;
          if (typeof args[0] === 'string') return args[0].length === 0;
          return !args[0];
        
        default:
          throw new EvaluationError(`Unknown function: ${node.name}`);
      }
    }
    default:
      throw new EvaluationError(`Unknown node type: ${(node as { type?: unknown }).type}`);
  }
}
