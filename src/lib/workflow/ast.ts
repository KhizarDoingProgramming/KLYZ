

// Tokens
export enum TokenType {
  Number, String, Boolean, Null, Identifier,
  Plus, Minus, Multiply, Divide, Modulo,
  Eq, Neq, Gt, Gte, Lt, Lte,
  And, Or, Not,
  Dot, BracketOpen, BracketClose,
  ParenOpen, ParenClose,
  Comma, EOF
}

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export class ExpressionLexer {
  private pos = 0;
  constructor(private input: string) {}

  lex(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.input.length) {
      const char = this.input[this.pos] || '';
      if (/\s/.test(char)) {
        this.pos++;
        continue;
      }
      
      switch (char) {
        case '+': tokens.push({ type: TokenType.Plus, value: '+', pos: this.pos++ }); break;
        case '-': tokens.push({ type: TokenType.Minus, value: '-', pos: this.pos++ }); break;
        case '*': tokens.push({ type: TokenType.Multiply, value: '*', pos: this.pos++ }); break;
        case '/': tokens.push({ type: TokenType.Divide, value: '/', pos: this.pos++ }); break;
        case '%': tokens.push({ type: TokenType.Modulo, value: '%', pos: this.pos++ }); break;
        case '(': tokens.push({ type: TokenType.ParenOpen, value: '(', pos: this.pos++ }); break;
        case ')': tokens.push({ type: TokenType.ParenClose, value: ')', pos: this.pos++ }); break;
        case '[': tokens.push({ type: TokenType.BracketOpen, value: '[', pos: this.pos++ }); break;
        case ']': tokens.push({ type: TokenType.BracketClose, value: ']', pos: this.pos++ }); break;
        case '.': tokens.push({ type: TokenType.Dot, value: '.', pos: this.pos++ }); break;
        case ',': tokens.push({ type: TokenType.Comma, value: ',', pos: this.pos++ }); break;
        case '=': 
          if (this.input[this.pos + 1] === '=') {
            tokens.push({ type: TokenType.Eq, value: '==', pos: this.pos });
            this.pos += 2;
          } else {
            throw new Error(`Unexpected character = at ${this.pos}`);
          }
          break;
        case '!':
          if (this.input[this.pos + 1] === '=') {
            tokens.push({ type: TokenType.Neq, value: '!=', pos: this.pos });
            this.pos += 2;
          } else {
            tokens.push({ type: TokenType.Not, value: '!', pos: this.pos++ });
          }
          break;
        case '<':
          if (this.input[this.pos + 1] === '=') {
            tokens.push({ type: TokenType.Lte, value: '<=', pos: this.pos });
            this.pos += 2;
          } else {
            tokens.push({ type: TokenType.Lt, value: '<', pos: this.pos++ });
          }
          break;
        case '>':
          if (this.input[this.pos + 1] === '=') {
            tokens.push({ type: TokenType.Gte, value: '>=', pos: this.pos });
            this.pos += 2;
          } else {
            tokens.push({ type: TokenType.Gt, value: '>', pos: this.pos++ });
          }
          break;
        case '&':
          if (this.input[this.pos + 1] === '&') {
            tokens.push({ type: TokenType.And, value: '&&', pos: this.pos });
            this.pos += 2;
          } else {
            throw new Error(`Unexpected character & at ${this.pos}`);
          }
          break;
        case '|':
          if (this.input[this.pos + 1] === '|') {
            tokens.push({ type: TokenType.Or, value: '||', pos: this.pos });
            this.pos += 2;
          } else {
            throw new Error(`Unexpected character | at ${this.pos}`);
          }
          break;
        case '"':
        case "'": {
          const quote = char;
          let str = '';
          this.pos++;
          while (this.pos < this.input.length && this.input[this.pos] !== quote) {
            str += this.input[this.pos++];
          }
          if (this.pos >= this.input.length) throw new Error(`Unterminated string at ${this.pos}`);
          this.pos++;
          tokens.push({ type: TokenType.String, value: str, pos: this.pos });
          break;
        }
        default: {
          if (/[0-9]/.test(char)) {
            let num = '';
            while (this.pos < this.input.length && /[0-9.]/.test(this.input[this.pos] || '')) {
              num += this.input[this.pos++];
            }
            tokens.push({ type: TokenType.Number, value: num, pos: this.pos });
          } else if (/[a-zA-Z_$]/.test(char)) {
            let id = '';
            while (this.pos < this.input.length && /[a-zA-Z0-9_$]/.test(this.input[this.pos] || '')) {
              id += this.input[this.pos++];
            }
            if (id === 'true' || id === 'false') {
              tokens.push({ type: TokenType.Boolean, value: id, pos: this.pos });
            } else if (id === 'null') {
              tokens.push({ type: TokenType.Null, value: id, pos: this.pos });
            } else {
              tokens.push({ type: TokenType.Identifier, value: id, pos: this.pos });
            }
          } else {
            throw new Error(`Unexpected character ${char} at ${this.pos}`);
          }
        }
      }
    }
    tokens.push({ type: TokenType.EOF, value: '', pos: this.pos });
    return tokens;
  }
}

export type ASTNode =
  | { type: 'Literal'; value: unknown }
  | { type: 'Path'; path: string }
  | { type: 'BinaryExpression'; operator: string; left: ASTNode; right: ASTNode }
  | { type: 'UnaryExpression'; operator: string; argument: ASTNode }
  | { type: 'FunctionCall'; name: string; args: ASTNode[] }
  ;

export class ExpressionParser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] || { type: TokenType.EOF, value: '', pos: this.pos };
  }

  private match(...types: TokenType[]): boolean {
    if (types.includes(this.peek().type)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private previous(): Token {
    return this.tokens[this.pos - 1] || { type: TokenType.EOF, value: '', pos: this.pos };
  }

  private consume(type: TokenType, message: string): Token {
    if (this.peek().type === type) {
      return this.tokens[this.pos++] || { type: TokenType.EOF, value: '', pos: this.pos };
    }
    throw new Error(message + ` at ${this.peek().pos}`);
  }

  public parse(): ASTNode {
    const node = this.or();
    if (this.peek().type !== TokenType.EOF) {
      throw new Error(`Unexpected token ${this.peek().value} at ${this.peek().pos}`);
    }
    return node;
  }

  private or(): ASTNode {
    let expr = this.and();
    while (this.match(TokenType.Or)) {
      const op = this.previous();
      const right = this.and();
      expr = { type: 'BinaryExpression', operator: op.value, left: expr, right };
    }
    return expr;
  }

  private and(): ASTNode {
    let expr = this.equality();
    while (this.match(TokenType.And)) {
      const op = this.previous();
      const right = this.equality();
      expr = { type: 'BinaryExpression', operator: op.value, left: expr, right };
    }
    return expr;
  }

  private equality(): ASTNode {
    let expr = this.comparison();
    while (this.match(TokenType.Eq, TokenType.Neq)) {
      const op = this.previous();
      const right = this.comparison();
      expr = { type: 'BinaryExpression', operator: op.value, left: expr, right };
    }
    return expr;
  }

  private comparison(): ASTNode {
    let expr = this.term();
    while (this.match(TokenType.Gt, TokenType.Gte, TokenType.Lt, TokenType.Lte)) {
      const op = this.previous();
      const right = this.term();
      expr = { type: 'BinaryExpression', operator: op.value, left: expr, right };
    }
    return expr;
  }

  private term(): ASTNode {
    let expr = this.factor();
    while (this.match(TokenType.Plus, TokenType.Minus)) {
      const op = this.previous();
      const right = this.factor();
      expr = { type: 'BinaryExpression', operator: op.value, left: expr, right };
    }
    return expr;
  }

  private factor(): ASTNode {
    let expr = this.unary();
    while (this.match(TokenType.Multiply, TokenType.Divide, TokenType.Modulo)) {
      const op = this.previous();
      const right = this.unary();
      expr = { type: 'BinaryExpression', operator: op.value, left: expr, right };
    }
    return expr;
  }

  private unary(): ASTNode {
    if (this.match(TokenType.Not, TokenType.Minus)) {
      const op = this.previous();
      const right = this.unary();
      return { type: 'UnaryExpression', operator: op.value, argument: right };
    }
    return this.call();
  }

  private call(): ASTNode {
    let expr = this.primary();
    
    while (true) {
      if (this.match(TokenType.ParenOpen)) {
        if (expr.type !== 'Path' || expr.path.includes('.')) {
            throw new Error(`Only top level identifiers can be called as functions`);
        }
        const name = expr.path;
        const args: ASTNode[] = [];
        if (this.peek().type !== TokenType.ParenClose) {
          do {
            args.push(this.or());
          } while (this.match(TokenType.Comma));
        }
        this.consume(TokenType.ParenClose, "Expected ')' after arguments.");
        expr = { type: 'FunctionCall', name, args };
      } else if (this.match(TokenType.Dot)) {
        const id = this.consume(TokenType.Identifier, "Expected property name after '.'.");
        if (expr.type === 'Path') {
          expr = { type: 'Path', path: expr.path + '.' + id.value };
        } else {
          throw new Error("Can only use '.' on paths.");
        }
      } else if (this.match(TokenType.BracketOpen)) {
        if (expr.type !== 'Path') {
          throw new Error("Can only use '[]' on paths.");
        }
        if (this.match(TokenType.Number)) {
            expr = { type: 'Path', path: expr.path + '[' + this.previous().value + ']' };
        } else if (this.match(TokenType.String)) {
            expr = { type: 'Path', path: expr.path + '["' + this.previous().value + '"]' };
        } else {
            throw new Error("Expected number or string inside brackets.");
        }
        this.consume(TokenType.BracketClose, "Expected ']' after bracket index.");
      } else {
        break;
      }
    }
    
    return expr;
  }

  private primary(): ASTNode {
    if (this.match(TokenType.Number)) return { type: 'Literal', value: parseFloat(this.previous().value) };
    if (this.match(TokenType.String)) return { type: 'Literal', value: this.previous().value };
    if (this.match(TokenType.Boolean)) return { type: 'Literal', value: this.previous().value === 'true' };
    if (this.match(TokenType.Null)) return { type: 'Literal', value: null };
    if (this.match(TokenType.Identifier)) {
        return { type: 'Path', path: this.previous().value };
    }
    if (this.match(TokenType.ParenOpen)) {
      const expr = this.or();
      this.consume(TokenType.ParenClose, "Expected ')' after expression.");
      return expr;
    }
    throw new Error(`Expected expression at ${this.peek().pos}, got ${this.peek().value}`);
  }
}
