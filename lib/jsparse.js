/* -*- Mode: JS; tab-width: 4; indent-tabs-mode: nil; -*-
 * vim: set sw=4 ts=4 et tw=78:
 * ***** BEGIN LICENSE BLOCK *****
 *
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Narcissus JavaScript engine.
 *
 * The Initial Developer of the Original Code is
 * Brendan Eich <brendan@mozilla.org>.
 * Portions created by the Initial Developer are Copyright (C) 2004
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Tom Austin <taustin@ucsc.edu>
 *   Brendan Eich <brendan@mozilla.org>
 *   Shu-Yu Guo <shu@rfrn.org>
 *   Dave Herman <dherman@mozilla.com>
 *   Dimitris Vardoulakis <dimvar@ccs.neu.edu>
 *   Patrick Walton <pcwalton@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/*
 * Narcissus - JS implemented in JS.
 *
 * Parser.
 */

Narcissus.parser = (function() {

    var lexer = Narcissus.lexer;
    var definitions = Narcissus.definitions;

    // Set constants in the local scope.
    eval(definitions.consts);

    /*
     * Recursively add all destructured declarations to varDecls.
     */
    function pushDestructuringVarDecls(n, x) {
        for (var i in n) {
            var sub = n[i];
            if (sub.type === IDENTIFIER) {
                x.varDecls.push(sub);
            } else {
                pushDestructuringVarDecls(sub, x);
            }
        }
    }

    function StaticContext(inFunction) {
        this.inFunction = inFunction;
        this.hasEmptyReturn = false;
        this.hasReturnWithValue = false;
        this.isGenerator = false;
        this.usesSuper = false;
        this.possibleDirectEval = false;
        this.stmtStack = [];
        this.funDecls = [];
        this.varDecls = [];
        Narcissus.options.ecma3OnlyMode && (this.ecma3OnlyMode = true);
        Narcissus.options.parenFreeMode && (this.parenFreeMode = true);
        Narcissus.options.version === "harmony" && (this.harmonyMode = true);
        Narcissus.options.ecma3OnlyMode && (this.harmonyMode = this.parenFreeMode = false);
        
    }

    StaticContext.prototype = {
        bracketLevel: 0,
        curlyLevel: 0,
        parenLevel: 0,
        hookLevel: 0,
        inForLoopInit: false,
        ecma3OnlyMode: false,
        parenFreeMode: false,
        harmonyMode: false,
        maybeMatchLeftParen: function (t) {
            if (this.parenFreeMode)
               return t.match(LEFT_PAREN) ? LEFT_PAREN : END;
            return t.mustMatch(LEFT_PAREN);
        },
        maybeMatchRightParen: function (t, p) {
            if (this.parenFreeMode && p !== LEFT_PAREN) return;
            t.mustMatch(RIGHT_PAREN);
        },
    };

    /*
     * Script :: (tokenizer, compiler context) -> node
     *
     * Parses the toplevel and function bodies.
     */
    function Script(t, x) {
        var n = Statements(t, x);
        n.type = SCRIPT;
        n.funDecls = x.funDecls;
        n.varDecls = x.varDecls;
        return n;
    }

    // We extend Array slightly with a top-of-stack method.
    definitions.defineProperty(Array.prototype, "top",
                               function() {
                                   return this.length && this[this.length-1];
                               }, false, false, true);

    /*
     * Node :: (tokenizer, optional init object) -> node
     */
    function Node(t, init) {
        var token = t.token;
        if (token) {
            // If init.type exists it will override token.type.
            this.type = token.type;
            this.value = token.value;
            this.lineno = token.lineno;

            // Start and end are file positions for error handling.
            this.start = token.start;
            this.end = token.end;
        } else {
            this.lineno = t.lineno;
        }

        // Node uses a tokenizer for debugging (getSource, filename getter).
        this.tokenizer = t;
        this.children = [];

        for (var prop in init)
            this[prop] = init[prop];
    }

    var Np = Node.prototype = {};
    Np.constructor = Node;
    Np.toSource = Object.prototype.toSource;

    // Always use push to add operands to an expression, to update start and end.
    Np.push = function (kid) {
        // kid can be null e.g. [1, , 2].
        if (kid !== null) {
            if (kid.start < this.start)
                this.start = kid.start;
            if (this.end < kid.end)
                this.end = kid.end;
        }
        return this.children.push(kid);
    }

    Node.indentLevel = 0;

    function tokenString(tt) {
        var t = definitions.tokens[tt];
        return /^\W/.test(t) ? definitions.opTypeNames[t] : t.toUpperCase();
    }

    Np.toString = function () {
        var a = [];
        for (var i in this) {
            if (this.hasOwnProperty(i) && i !== 'type' && i !== 'target')
                a.push({id: i, value: this[i]});
        }
        a.sort(function (a,b) { return (a.id < b.id) ? -1 : 1; });
        const INDENTATION = "    ";
        var n = ++Node.indentLevel;
        var s = "{\n" + INDENTATION.repeat(n) + "type: " + tokenString(this.type);
        for (i = 0; i < a.length; i++)
            s += ",\n" + INDENTATION.repeat(n) + a[i].id + ": " + a[i].value;
        n = --Node.indentLevel;
        s += "\n" + INDENTATION.repeat(n) + "}";
        return s;
    }

    Np.getSource = function () {
        return this.tokenizer.source.slice(this.start, this.end);
    };

    /*
     * Helper init objects for common nodes.
     */

    const BLOCK_INIT = { type: BLOCK, varDecls: [] };
    const LOOP_INIT = { isLoop: true };

    definitions.defineGetter(Np, "filename",
                             function() {
                                 return this.tokenizer.filename;
                             });

    definitions.defineGetter(Np, "length",
                             function() {
                                 throw new Error("Node.prototype.length is gone; " +
                                                 "use n.children.length instead");
                             });

    definitions.defineProperty(String.prototype, "repeat",
                               function(n) {
                                   var s = "", t = this + s;
                                   while (--n >= 0)
                                       s += t;
                                   return s;
                               }, false, false, true);

    // Statement stack and nested statement handler.
    function nest(t, x, node, func, end) {
        x.stmtStack.push(node);
        var n = func(t, x);
        x.stmtStack.pop();
        end && t.mustMatch(end);
        return n;
    }

    /*
     * Statements :: (tokenizer, compiler context) -> node
     *
     * Parses a list of Statements.
     */
    function Statements(t, x) {
        var n = new Node(t, BLOCK_INIT);
        x.stmtStack.push(n);
        while (!t.done && t.peek(true) !== RIGHT_CURLY)
            n.push(Statement(t, x));
        x.stmtStack.pop();
        return n;
    }

    function Block(t, x) {
        t.mustMatch(LEFT_CURLY);
        var n = Statements(t, x);
        t.mustMatch(RIGHT_CURLY);
        return n;
    }

    const DECLARED_FORM = 0, EXPRESSED_FORM = 1, STATEMENT_FORM = 2, METHOD_FORM = 3;

    /*
     * Statement :: (tokenizer, compiler context) -> node
     *
     * Parses a Statement.
     */
    function Statement(t, x) {
        var i, label, n, n2, p, c, ss, tt = t.get(true), tt2;

        // Cases for statements ending in a right curly return early, avoiding the
        // common semicolon insertion magic after this switch.
        switch (tt) {
          case FUNCTION:
            // DECLARED_FORM extends funDecls of x, STATEMENT_FORM doesn't.
            return FunctionDefinition(t, x, true,
                                      (x.stmtStack.length > 1)
                                      ? STATEMENT_FORM
                                      : DECLARED_FORM);

          case LEFT_CURLY:
            n = Statements(t, x);
            t.mustMatch(RIGHT_CURLY);
            return n;

          case IF:
            n = new Node(t);
            n.condition = HeadExpression(t, x);
            x.stmtStack.push(n);
            n.thenPart = Statement(t, x);
            n.elsePart = t.match(ELSE) ? Statement(t, x) : null;
            x.stmtStack.pop();
            return n;

          case SWITCH:
            // This allows CASEs after a DEFAULT, which is in the standard.
            n = new Node(t, { cases: [], defaultIndex: -1 });
            n.discriminant = HeadExpression(t, x);
            x.stmtStack.push(n);
            t.mustMatch(LEFT_CURLY);
            while ((tt = t.get()) !== RIGHT_CURLY) {
                switch (tt) {
                  case DEFAULT:
                    if (n.defaultIndex >= 0)
                        throw t.newSyntaxError("More than one switch default");
                    // FALL THROUGH
                  case CASE:
                    n2 = new Node(t);
                    if (tt === DEFAULT)
                        n.defaultIndex = n.cases.length;
                    else
                        n2.caseLabel = Expression(t, x, COLON);
                    break;

                  default:
                    throw t.newSyntaxError("Invalid switch case");
                }
                t.mustMatch(COLON);
                n2.statements = new Node(t, BLOCK_INIT);
                while ((tt=t.peek(true)) !== CASE && tt !== DEFAULT &&
                        tt !== RIGHT_CURLY)
                    n2.statements.push(Statement(t, x));
                n.cases.push(n2);
            }
            x.stmtStack.pop();
            return n;

          case FOR:
            n = new Node(t, LOOP_INIT);
            if (t.match(IDENTIFIER)) {
                if (t.token.value === "each")
                     n.isEach = true;
                 else
                     t.unget();
            }
            if (!x.parenFreeMode)
                t.mustMatch(LEFT_PAREN);
            if ((tt = t.peek()) !== SEMICOLON) {
                x.inForLoopInit = true;
                if (tt === VAR || tt === CONST) {
                    t.get();
                    n2 = Variables(t, x);
                } else if (tt === LET) {
                    t.get();
                    if (t.peek() === LEFT_PAREN) {
                        n2 = LetBlock(t, x, false);
                    } else {
                        // Let in for head, we need to add an implicit block
                        // around the rest of the for.
                        var forBlock = new Node(t, BLOCK_INIT);
                        x.stmtStack.push(forBlock);
                        n2 = Variables(t, x, forBlock);
                    }
                } else {
                    n2 = Expression(t, x);
                }
                x.inForLoopInit = false;
            }
            if (n2 && t.match(IN)) {
                n.type = FOR_IN;
                n.object = Expression(t, x);
                if (n2.type === VAR || n2.type === LET) {
                    c = n2.children;

                    // Destructuring turns one decl into multiples, so either
                    // there must be only one destructuring or only one
                    // decl.
                    if (c.length !== 1 && n2.destructurings.length !== 1) {
                        throw new SyntaxError("Invalid for..in left-hand side",
                                              t.filename, n2.lineno);
                    }
                    if (n2.destructurings.length > 0) {
                        n.iterator = n2.destructurings[0];
                    } else {
                        n.iterator = c[0];
                    }
                    n.varDecl = n2;
                } else {
                    if (n2.type === ARRAY_INIT || n2.type === OBJECT_INIT) {
                        n2.destructuredNames = checkDestructuring(t, x, n2);
                    }
                    n.iterator = n2;
                }
            } else {
                n.setup = n2;
                t.mustMatch(SEMICOLON);
                if (n.isEach)
                    throw t.newSyntaxError("Invalid for each..in loop");
                n.condition = (t.peek() === SEMICOLON)
                              ? null
                              : Expression(t, x);
                t.mustMatch(SEMICOLON);
                tt2 = t.peek();
                n.update = (x.parenFreeMode
                            ? tt2 === LEFT_CURLY ||
                              definitions.keywords[definitions.tokens[tt2]] === tt2
                            : tt2 === RIGHT_PAREN)
                           ? null
                           : Expression(t, x);
            }
            if (!x.parenFreeMode)
                t.mustMatch(RIGHT_PAREN);
            n.body = nest(t, x, n, Statement);
            if (forBlock)
                x.stmtStack.pop();

            return n;

          case WHILE:
            n = new Node(t, { isLoop: true });
            n.condition = HeadExpression(t, x);
            n.body = nest(t, x, n, Statement);
            return n;

          case DO:
            n = new Node(t, { isLoop: true });
            n.body = nest(t, x, n, Statement, WHILE);
            n.condition = HeadExpression(t, x);
            if (!x.ecmaStrictMode) {
                // <script language="JavaScript"> (without version hints) may need
                // automatic semicolon insertion without a newline after do-while.
                // See http://bugzilla.mozilla.org/show_bug.cgi?id=238945.
                t.match(SEMICOLON);
                return n;
            }
            break;

          case BREAK:
          case CONTINUE:
            n = new Node(t);

            if (t.peekOnSameLine() === IDENTIFIER) {
                t.get();
                n.label = t.token.value;
            }

            ss = x.stmtStack;
            i = ss.length;
            label = n.label;

            if (label) {
                do {
                    if (--i < 0)
                        throw t.newSyntaxError("Label not found");
                } while (ss[i].label !== label);

                // Both break and continue to label need to be handled specially
                // within a labeled loop, so that they target that loop. If not in
                // a loop, then break targets its labeled statement. Labels can be
                // nested so we skip all labels immediately enclosing the nearest
                // non-label statement.
                while (i < ss.length - 1 && ss[i+1].type === LABEL)
                    i++;
                if (i < ss.length - 1 && ss[i+1].isLoop)
                    i++;
                else if (tt === CONTINUE)
                    throw t.newSyntaxError("Invalid continue");
            } else {
                do {
                    if (--i < 0) {
                        throw t.newSyntaxError("Invalid " + ((tt === BREAK)
                                                             ? "break"
                                                             : "continue"));
                    }
                } while (!ss[i].isLoop && !(tt === BREAK && ss[i].type === SWITCH));
            }
            n.target = ss[i];
            break;

          case TRY:
            n = new Node(t, { catchClauses: [] });
            n.tryBlock = Block(t, x);
            while (t.match(CATCH)) {
                n2 = new Node(t);
                p = x.maybeMatchLeftParen(t);
                switch (t.get()) {
                  case LEFT_BRACKET:
                  case LEFT_CURLY:
                    // Destructured catch identifiers.
                    t.unget();
                    n2.varName = DestructuringExpression(t, x, true);
                    break;
                  case IDENTIFIER:
                    n2.varName = t.token.value;
                    break;
                  default:
                    throw t.newSyntaxError("missing identifier in catch");
                    break;
                }
                if (t.match(IF)) {
                    if (x.ecma3OnlyMode)
                        throw t.newSyntaxError("Illegal catch guard");
                    if (n.catchClauses.length && !n.catchClauses.top().guard)
                        throw t.newSyntaxError("Guarded catch after unguarded");
                    n2.guard = Expression(t, x);
                }
                x.maybeMatchRightParen(t, p);
                n2.block = Block(t, x);
                n.catchClauses.push(n2);
            }
            if (t.match(FINALLY))
                n.finallyBlock = Block(t, x);
            if (!n.catchClauses.length && !n.finallyBlock)
                throw t.newSyntaxError("Invalid try statement");
            return n;

          case CATCH:
          case FINALLY:
            throw t.newSyntaxError(definitions.tokens[tt] + " without preceding try");

          case THROW:
            n = new Node(t);
            n.exception = Expression(t, x);
            break;

          case RETURN:
            n = ReturnOrYield(t, x);
            break;

          case WITH:
            n = new Node(t);
            n.object = HeadExpression(t, x);
            n.body = nest(t, x, n, Statement);
            return n;

          case VAR:
          case CONST:
            n = Variables(t, x);
            break;

          case LET:
            if (t.peek() === LEFT_PAREN)
                n = LetBlock(t, x, true);
            else
                n = Variables(t, x);
            break;

          case DEBUGGER:
            n = new Node(t);
            break;

          case NEWLINE:
          case SEMICOLON:
            n = new Node(t, { type: SEMICOLON });
            n.expression = null;
            return n;

          default:
            if (tt === IDENTIFIER) {
                tt = t.peek();
                // Labeled statement.
                if (tt === COLON) {
                    label = t.token.value;
                    ss = x.stmtStack;
                    for (i = ss.length-1; i >= 0; --i) {
                        if (ss[i].label === label)
                            throw t.newSyntaxError("Duplicate label");
                    }
                    t.get();
                    n = new Node(t, { type: LABEL, label: label });
                    n.statement = nest(t, x, n, Statement);
                    return n;
                }
            }

            // Expression statement.
            // We unget the current token to parse the expression as a whole.
            n = new Node(t, { type: SEMICOLON });
            t.unget();
            n.expression = Expression(t, x);
            n.end = n.expression.end;
            break;
        }

        MagicalSemicolon(t);
        return n;
    }

    function MagicalSemicolon(t) {
        var tt;
        if (t.lineno === t.token.lineno) {
            tt = t.peekOnSameLine();
            if (tt !== END && tt !== NEWLINE && tt !== SEMICOLON && tt !== RIGHT_CURLY)
                throw t.newSyntaxError("missing ; before statement");
        }
        t.match(SEMICOLON);
    }

    function ReturnOrYield(t, x) {
        var n, b, tt = t.token.type, tt2;

        if (tt === RETURN) {
            if (!x.inFunction)
                throw t.newSyntaxError("Return not in function");
        } else /* if (tt === YIELD) */ {
            if (!x.inFunction)
                throw t.newSyntaxError("Yield not in function");
            x.isGenerator = true;
        }
        n = new Node(t, { value: undefined });

        tt2 = t.peek(true);
        if (tt2 !== END && tt2 !== NEWLINE &&
            tt2 !== SEMICOLON && tt2 !== RIGHT_CURLY
            && (tt !== YIELD ||
                (tt2 !== tt && tt2 !== RIGHT_BRACKET && tt2 !== RIGHT_PAREN &&
                 tt2 !== COLON && tt2 !== COMMA))) {
            if (tt === RETURN) {
                n.value = Expression(t, x);
                x.hasReturnWithValue = true;
            } else {
                n.value = AssignExpression(t, x);
            }
        } else if (tt === RETURN) {
            x.hasEmptyReturn = true;
        }

        // Disallow return v; in generator.
        if (x.hasReturnWithValue && x.isGenerator)
            throw t.newSyntaxError("Generator returns a value");

        return n;
    }

    /*
     * FunctionDefinition :: (tokenizer, compiler context, boolean,
     *                        DECLARED_FORM or EXPRESSED_FORM or STATEMENT_FORM or METHOD_FORM)
     *                    -> node
     */
    function FunctionDefinition(t, x, requireName, functionForm) {
        var tt, x2;
        var f = new Node(t, { params: [] });
        if (f.type !== FUNCTION) f.type = FUNCTION;
       if (t.match(IDENTIFIER))
            f.name = t.token.value;
        else if (requireName)
            throw t.newSyntaxError("missing function identifier");

        x2 = new StaticContext(true);

        t.mustMatch(LEFT_PAREN);
        if (!t.match(RIGHT_PAREN)) {
            do {
                switch (t.get()) {
                  case LEFT_BRACKET:
                  case LEFT_CURLY:
                    // Destructured formal parameters.
                    t.unget();
                    f.params.push(DestructuringExpression(t, x2));
                    break;
                  case IDENTIFIER:
                    f.params.push(t.token.value);
                    break;
                  default:
                    throw t.newSyntaxError("missing formal parameter");
                    break;
                }
            } while (t.match(COMMA));
            t.mustMatch(RIGHT_PAREN);
        }

        // Do we have an expression closure or a normal body?
        tt = t.get();
        if (tt !== LEFT_CURLY)
            t.unget();

        if (tt !== LEFT_CURLY) {
            f.body = AssignExpression(t, x2);
            if (x2.isGenerator)
                throw t.newSyntaxError("Generator returns a value");
        } else {
            f.body = Script(t, x2);
        }

        if (tt === LEFT_CURLY)
            t.mustMatch(RIGHT_CURLY);
            
        f.usesSuper = x2.usesSuper || x2.possibleDirectEval;
        f.end = t.token.end;
        f.functionForm = functionForm;
        if (functionForm === DECLARED_FORM)
            x.funDecls.push(f);
        return f;
    }

    /*
     * Variables :: (tokenizer, compiler context) -> node
     *
     * Parses a comma-separated list of var declarations (and maybe
     * initializations).
     */
    function Variables(t, x, letBlock) {
        var n, n2, ss, i, s, tt;

        tt = t.token.type;
        switch (tt) {
          case VAR:
            s = x;
            break;
          case CONST:
            s = x;
            break;
          case LET:
          case LEFT_PAREN:
            tt = LET;
            if (!letBlock) {
                ss = x.stmtStack;
                i = ss.length;
                while (ss[--i].type !== BLOCK) ; // a BLOCK *must* be found.
                // Lets at the function toplevel are just vars, at least in
                // SpiderMonkey.
                if (i === 0) {
                    s = x;
                } else {
                    s = ss[i];
                }
            } else {
                s = letBlock;
            }
            break;
        }

        n = new Node(t, { type: tt, destructurings: [] });

        do {
            tt = t.get();
            if (tt === LEFT_BRACKET || tt === LEFT_CURLY) {
                // Need to unget to parse the full destructured expression.
                t.unget();

                var dexp = DestructuringExpression(t, x, true, s);

                n2 = new Node(t, { type: IDENTIFIER,
                                   name: dexp,
                                   readOnly: n.type === CONST });
                n.push(n2);
                pushDestructuringVarDecls(n2.name.destructuredNames, s);
                n.destructurings.push({ exp: dexp, decl: n2 });

                if (x.inForLoopInit && t.peek() === IN) {
                    continue;
                }

                t.mustMatch(ASSIGN);
                if (t.token.assignOp)
                    throw t.newSyntaxError("Invalid variable initialization");

                n2.initializer = AssignExpression(t, x);

                continue;
            }

            if (tt !== IDENTIFIER)
                throw t.newSyntaxError("missing variable name");

            n2 = new Node(t, { type: IDENTIFIER,
                               name: t.token.value,
                               readOnly: n.type === CONST });
            n.push(n2);
            s.varDecls.push(n2);

            if (t.match(ASSIGN)) {
                if (t.token.assignOp)
                    throw t.newSyntaxError("Invalid variable initialization");

                n2.initializer = AssignExpression(t, x);
            }
        } while (t.match(COMMA));

        return n;
    }

    /*
     * LetBlock :: (tokenizer, compiler context, boolean) -> node
     *
     * Does not handle let inside of for loop init.
     */
    function LetBlock(t, x, isStatement) {
        var n, n2;

        // t.token.type must be LET
        n = new Node(t, { type: LET_BLOCK, varDecls: [] });
        t.mustMatch(LEFT_PAREN);
        n.variables = Variables(t, x, n);
        t.mustMatch(RIGHT_PAREN);

        if (isStatement && t.peek() !== LEFT_CURLY) {
            /*
             * If this is really an expression in let statement guise, then we
             * need to wrap the LET_BLOCK node in a SEMICOLON node so that we pop
             * the return value of the expression.
             */
            n2 = new Node(t, { type: SEMICOLON,
                               expression: n });
            isStatement = false;
        }

        if (isStatement)
            n.block = Block(t, x);
        else
            n.expression = AssignExpression(t, x);

        return n;
    }

    function checkDestructuring(t, x, n, simpleNamesOnly, data) {
        if (n.type === ARRAY_COMP)
            throw t.newSyntaxError("Invalid array comprehension left-hand side");
        if (n.type !== ARRAY_INIT && n.type !== OBJECT_INIT)
            return;

        var lhss = {};
        var nn, n2, idx, sub, cc, c = n.children;
        for (var i = 0, j = c.length; i < j; i++) {
            if (!(nn = c[i]))
                continue;
            if (nn.type === PROPERTY_INIT) {
                cc = nn.children;
                sub = cc[1];
                idx = cc[0].value;
            } else if (n.type === OBJECT_INIT) {
                // Do we have destructuring shorthand {foo, bar}?
                sub = nn;
                idx = nn.value;
            } else {
                sub = nn;
                idx = i;
            }

            if (sub.type === ARRAY_INIT || sub.type === OBJECT_INIT) {
                lhss[idx] = checkDestructuring(t, x, sub,
                                               simpleNamesOnly, data);
            } else {
                if (simpleNamesOnly && sub.type !== IDENTIFIER) {
                    // In declarations, lhs must be simple names
                    throw t.newSyntaxError("missing name in pattern");
                }

                lhss[idx] = sub;
            }
        }

        return lhss;
    }

    function DestructuringExpression(t, x, simpleNamesOnly, data) {
        var n = PrimaryExpression(t, x);
        // Keep the list of lefthand sides for varDecls
        n.destructuredNames = checkDestructuring(t, x, n,
                                                 simpleNamesOnly, data);
        return n;
    }

    function GeneratorExpression(t, x, e) {
        return new Node(t, { type: GENERATOR,
                             expression: e,
                             tail: ComprehensionTail(t, x) });
    }

    function ComprehensionTail(t, x) {
        var body, n, n2, n3, p;

        // t.token.type must be FOR
        body = new Node(t, { type: COMP_TAIL });

        do {
            // Comprehension tails are always for..in loops.
            n = new Node(t, { type: FOR_IN, isLoop: true });
            if (t.match(IDENTIFIER)) {
                // But sometimes they're for each..in.
                if (t.token.value === "each")
                    n.isEach = true;
                else
                    t.unget();
            }
            p = x.maybeMatchLeftParen(t);
            switch(t.get()) {
              case LEFT_BRACKET:
              case LEFT_CURLY:
                t.unget();
                // Destructured left side of for in comprehension tails.
                n.iterator = DestructuringExpression(t, x);
                break;

              case IDENTIFIER:
                n.iterator = n3 = new Node(t, { type: IDENTIFIER });
                n3.name = n3.value;
                n.varDecl = n2 = new Node(t, { type: VAR });
                n2.push(n3);
                x.varDecls.push(n3);
                // Don't add to varDecls since the semantics of comprehensions is
                // such that the variables are in their own function when
                // desugared.
                break;

              default:
                throw t.newSyntaxError("missing identifier");
            }
            t.mustMatch(IN);
            n.object = Expression(t, x);
            x.maybeMatchRightParen(t, p);
            body.push(n);
        } while (t.match(FOR));

        // Optional guard.
        if (t.match(IF))
            body.guard = HeadExpression(t, x);

        return body;
    }

    function HeadExpression(t, x) {
        var p = x.maybeMatchLeftParen(t);
        var n = ParenExpression(t, x);
        x.maybeMatchRightParen(t, p);
        if (p === END && !n.parenthesized) {
            var tt = t.peek();
            if (tt !== LEFT_CURLY && definitions.keywords[definitions.tokens[tt]] !== tt)
                throw t.newSyntaxError("Unparenthesized head followed by unbraced body");
        }
        return n;
    }

    function ParenExpression(t, x) {
        // Always accept the 'in' operator in a parenthesized expression,
        // where it's unambiguous, even if we might be parsing the init of a
        // for statement.
        var oldLoopInit = x.inForLoopInit;
        x.inForLoopInit = (t.token.type === LEFT_PAREN);
        var n = Expression(t, x);
        x.inForLoopInit = oldLoopInit;

        if (t.match(FOR)) {
            if (n.type === YIELD && !n.parenthesized)
                throw t.newSyntaxError("Yield expression must be parenthesized");
            if (n.type === COMMA && !n.parenthesized)
                throw t.newSyntaxError("Generator expression must be parenthesized");
            n = GeneratorExpression(t, x, n);
        }

        return n;
    }

    /*
     * Expression :: (tokenizer, compiler context) -> node
     *
     * Top-down expression parser matched against SpiderMonkey.
     */
    function Expression(t, x) {
        var n, n2;

        n = AssignExpression(t, x);
        if (t.match(COMMA)) {
            n2 = new Node(t, { type: COMMA });
            n2.push(n);
            n = n2;
            do {
                n2 = n.children[n.children.length-1];
                if (n2.type === YIELD && !n2.parenthesized)
                    throw t.newSyntaxError("Yield expression must be parenthesized");
                n.push(AssignExpression(t, x));
            } while (t.match(COMMA));
        }

        return n;
    }

    function AssignExpression(t, x) {
        var n, lhs;

        // Have to treat yield like an operand because it could be the leftmost
        // operand of the expression.
        if (t.match(YIELD, true))
            return ReturnOrYield(t, x);

        n = new Node(t, { type: ASSIGN });
        lhs = ConditionalExpression(t, x);

        if (!t.match(ASSIGN)) {
            return lhs;
        }

        switch (lhs.type) {
          case OBJECT_INIT:
          case ARRAY_INIT:
            lhs.destructuredNames = checkDestructuring(t, x, lhs);
            // FALL THROUGH
          case IDENTIFIER: case DOT: case INDEX: case CALL: case SUPER_DOT: case SUPER_INDEX:
            break;
          default:
            throw t.newSyntaxError("Bad left-hand side of assignment");
            break;
        }

        n.assignOp = t.token.assignOp;
        n.push(lhs);
        n.push(AssignExpression(t, x));

        return n;
    }

    function ConditionalExpression(t, x) {
        var n, n2;

        n = OrExpression(t, x);
        if (t.match(HOOK)) {
            n2 = n;
            n = new Node(t, { type: HOOK });
            n.push(n2);
            /*
             * Always accept the 'in' operator in the middle clause of a ternary,
             * where it's unambiguous, even if we might be parsing the init of a
             * for statement.
             */
            var oldLoopInit = x.inForLoopInit;
            x.inForLoopInit = false;
            n.push(AssignExpression(t, x));
            x.inForLoopInit = oldLoopInit;
            if (!t.match(COLON))
                throw t.newSyntaxError("missing : after ?");
            n.push(AssignExpression(t, x));
        }

        return n;
    }

    function OrExpression(t, x) {
        var n, n2;

        n = AndExpression(t, x);
        while (t.match(OR)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(AndExpression(t, x));
            n = n2;
        }

        return n;
    }

    function AndExpression(t, x) {
        var n, n2;

        n = BitwiseOrExpression(t, x);
        while (t.match(AND)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(BitwiseOrExpression(t, x));
            n = n2;
        }

        return n;
    }

    function BitwiseOrExpression(t, x) {
        var n, n2;

        n = BitwiseXorExpression(t, x);
        while (t.match(BITWISE_OR)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(BitwiseXorExpression(t, x));
            n = n2;
        }

        return n;
    }

    function BitwiseXorExpression(t, x) {
        var n, n2;

        n = BitwiseAndExpression(t, x);
        while (t.match(BITWISE_XOR)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(BitwiseAndExpression(t, x));
            n = n2;
        }

        return n;
    }

    function BitwiseAndExpression(t, x) {
        var n, n2;

        n = EqualityExpression(t, x);
        while (t.match(BITWISE_AND)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(EqualityExpression(t, x));
            n = n2;
        }

        return n;
    }

    function EqualityExpression(t, x) {
        var n, n2;

        n = RelationalExpression(t, x);
        while (t.match(EQ) || t.match(NE) ||
               t.match(STRICT_EQ) || t.match(STRICT_NE)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(RelationalExpression(t, x));
            n = n2;
        }

        return n;
    }

    function RelationalExpression(t, x) {
        var n, n2;
        var oldLoopInit = x.inForLoopInit;

        /*
         * Uses of the in operator in shiftExprs are always unambiguous,
         * so unset the flag that prohibits recognizing it.
         */
        x.inForLoopInit = false;
        n = ShiftExpression(t, x);
        while ((t.match(LT) || t.match(LE) || t.match(GE) || t.match(GT) ||
               (oldLoopInit === false && t.match(IN)) ||
               t.match(INSTANCEOF))) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(ShiftExpression(t, x));
            n = n2;
        }
        x.inForLoopInit = oldLoopInit;

        return n;
    }

    function ShiftExpression(t, x) {
        var n, n2;

        n = AddExpression(t, x);
        while (t.match(LSH) || t.match(RSH) || t.match(URSH)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(AddExpression(t, x));
            n = n2;
        }

        return n;
    }

    function AddExpression(t, x) {
        var n, n2;

        n = MultiplyExpression(t, x);
        while (t.match(PLUS) || t.match(MINUS)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(MultiplyExpression(t, x));
            n = n2;
        }

        return n;
    }

    function MultiplyExpression(t, x) {
        var n, n2;

        n = UnaryExpression(t, x);
        while (t.match(MUL) || t.match(DIV) || t.match(MOD)) {
            n2 = new Node(t);
            n2.push(n);
            n2.push(UnaryExpression(t, x));
            n = n2;
        }

        return n;
    }

    function UnaryExpression(t, x) {
        var n, n2, tt;

        switch (tt = t.get(true)) {
          case DELETE: case VOID: case TYPEOF:
          case NOT: case BITWISE_NOT: case PLUS: case MINUS:
            if (tt === PLUS)
                n = new Node(t, { type: UNARY_PLUS });
            else if (tt === MINUS)
                n = new Node(t, { type: UNARY_MINUS });
            else
                n = new Node(t);
            n.push(UnaryExpression(t, x));
            break;

          case INCREMENT:
          case DECREMENT:
            // Prefix increment/decrement.
            n = new Node(t);
            n.push(MemberExpression(t, x, true));
            break;

          default:
            t.unget();
            n = MemberExpression(t, x, true);

            // Don't look across a newline boundary for a postfix {in,de}crement.
            if (t.tokens[(t.tokenIndex + t.lookahead - 1) & 3].lineno ===
                t.lineno) {
                if (t.match(INCREMENT) || t.match(DECREMENT)) {
                    n2 = new Node(t, { postfix: true });
                    n2.push(n);
                    n = n2;
                }
            }
            break;
        }

        return n;
    }

    function MemberExpression(t, x, allowCallSyntax) {
        var n, n2, name, tt;

        if (t.match(NEW)) {
            n = new Node(t);
            n.push(MemberExpression(t, x, false));
            if (t.match(LEFT_PAREN)) {
                n.type = NEW_WITH_ARGS;
                n.push(ArgumentList(t, x));
            }
        } else {
            n = PrimaryExpression(t, x);
        }

        while ((tt = t.get()) !== END) {
            switch (tt) {
              case DOT:
                if (!x.ecma3OnlyMode && t.peek(true) === LEFT_CURLY) {
                    if (!x.harmonyMode) throw t.newSyntaxError("Missing identifier");
                    n2 = new Node(t, { type: EXTEND });
                    n2.push(n);
                    n2.push(ObjectInitializer(t, x, true));
                    break;
                }                   
                n2 = new Node(t);
                if (x.harmonyMode && n.type===SUPER) n2.type=SUPER_DOT;
                n2.push(n);
                if (t.get() === IDENTIFIER || t.token.isKeyword)  n2.push(new Node(t, { type: IDENTIFIER }))
                else throw t.newSyntaxError("Missing identifier" +  (x.harmonyMode ? " or object literal": "")); 
                break;
                
              case PROTO:  // <|
				if (x.ecma3OnlyMode || !x.harmonyMode)
				    throw t.newSyntaxError("Illegal operator");
                n2 = new Node(t, {type: PROTO});
                n2.push(n);
                n2.push(PrimaryExpression(t, x, true));
                break;

              case LEFT_BRACKET:
                n2 = new Node(t, { type: n.type===SUPER ? SUPER_INDEX : INDEX });
                n2.push(n);
                n2.push(Expression(t, x));
                t.mustMatch(RIGHT_BRACKET);
                break;

              case LEFT_PAREN:
                if (allowCallSyntax) {
                    n2 = new Node(t, { type: CALL });
                    n2.push(n);
                    n2.push(ArgumentList(t, x));
                    if (n.type === IDENTIFIER && n.value === "eval") x.possibleDirectEval = true;
                    break;
                }
                // FALL THROUGH
              default:
                t.unget();
                return n;
            }

            n = n2;
        }

        return n;
    }

    function ArgumentList(t, x) {
        var n, n2;

        n = new Node(t, { type: LIST });
        if (t.match(RIGHT_PAREN, true))
            return n;
        do {
            n2 = AssignExpression(t, x);
            if (n2.type === YIELD && !n2.parenthesized && t.peek() === COMMA)
                throw t.newSyntaxError("Yield expression must be parenthesized");
            if (t.match(FOR)) {
                n2 = GeneratorExpression(t, x, n2);
                if (n.children.length > 1 || t.peek(true) === COMMA)
                    throw t.newSyntaxError("Generator expression must be parenthesized");
            }
            n.push(n2);
        } while (t.match(COMMA));
        t.mustMatch(RIGHT_PAREN);

        return n;
    }

    function PrimaryExpression(t, x, mustBeLiteral) {
        var n, n2, tt = t.get(true);

        switch (tt) {
          case FUNCTION:
            n = FunctionDefinition(t, x, false, EXPRESSED_FORM);
            break;

          case LEFT_BRACKET:
            n = new Node(t, { type: ARRAY_INIT });
            while ((tt = t.peek(true)) !== RIGHT_BRACKET) {
                if (tt === COMMA) {
                    t.get();
                    n.push(null);
                    continue;
                }
                n.push(AssignExpression(t, x));
                if (tt !== COMMA && !t.match(COMMA))
                    break;
            }

            // If we matched exactly one element and got a FOR, we have an
            // array comprehension.
            if (n.children.length === 1 && t.match(FOR)) {
                n2 = new Node(t, { type: ARRAY_COMP,
                                   expression: n.children[0],
                                   tail: ComprehensionTail(t, x) });
                n = n2;
            }
            t.mustMatch(RIGHT_BRACKET);
            break;

          case LEFT_CURLY:
            n = ObjectInitializer(t, x, false);
            break;

          case LEFT_PAREN:
            if (mustBeLiteral) throw t.newSyntaxError("literal expected");
            n = ParenExpression(t, x);
            t.mustMatch(RIGHT_PAREN);
            n.parenthesized = true;
            break;

          case LET:
            if (mustBeLiteral) throw t.newSyntaxError("literal expected");
            n = LetBlock(t, x, false);
            break;

          case SUPER: 
            if (x.ecma3OnlyMode || !x.harmonyMode) throw t.newSyntaxError("super is reserved");
            x.usesSuper = true;
          case THIS: case IDENTIFIER: 
            if (mustBeLiteral) throw t.newSyntaxError("literal expected");
          case NULL: case TRUE: case FALSE:
          case NUMBER: case STRING: case REGEXP:
            n = new Node(t);
            break;

          default:
            throw t.newSyntaxError("missing operand");
            break;
        }

        return n;
    }
    
    function isPropertyName(tt) {
       return tt === IDENTIFIER || tt === STRING || tt === NUMBER || tt ===LEFT_BRACKET
              || definitions.keywords[definitions.tokens[tt]] === tt
    }

    function ObjectInitializer(t, x, lookForLeftCurly) {
        var n, n2, tt, ttpn;
		var id, fd, getter;
		var commaOptional;
		if (lookForLeftCurly) t.mustMatch(LEFT_CURLY);
		n = new Node(t, { type: OBJECT_INIT });
	
		object_init:
	    if (!t.match(RIGHT_CURLY)) {
			do {
			    commaOptional = false;
				tt = t.get();
				ttpn = t.peek();
				if ((t.token.value === "get" || t.token.value === "set") && isPropertyName(ttpn)) {
					if (x.ecma3OnlyMode)
						throw t.newSyntaxError("Illegal property accessor");
					getter = t.token.value === "get";
					n2 = new Node(t, { type: getter ? GETTER : SETTER });
					t.get();
					n2.propertyName = PropertyName(t, x);
					if (ttpn === IDENTIFIER) {
					   t.unget();
					   fd = FunctionDefinition(t, x, true, EXPRESSED_FORM);
					} else fd = FunctionDefinition(t, x, false, EXPRESSED_FORM);
					if (getter && fd.params.length !== 0)
					    throw t.newSyntaxError("get accessor, too many arguments")
					else if (!getter && fd.params.length !== 1)
                        throw t.newSyntaxError("set accessor, must have one argument");
                    n2.functionDef =fd;
					n.push(n2);
					x.harmonyMode && (commaOptional = true);
				} else {
				    if (tt===RIGHT_CURLY) {
						if (x.ecma3OnlyMode)
							throw t.newSyntaxError("Illegal trailing ,");
						break object_init;
					} else id = PropertyName(t,x);
					if (t.match(COLON)) {
						n2 = new Node(t, { type: PROPERTY_INIT, propertyName: id  });
						n2.initializer = AssignExpression(t, x);
						n.push(n2);
					} else if (t.peek() === LEFT_PAREN) {
					    if (x.ecma3OnlyMode || !x.harmonyMode)
						    throw t.newSyntaxError("Illegal property definition");
				        n2 = new Node(t, { type: METHOD_INIT, propertyName: id });
					    if (tt  === IDENTIFIER) {
					       t.unget();
					       n2.functionDef = FunctionDefinition(t, x, true, METHOD_FORM);
					    } else n2.functionDef = FunctionDefinition(t, x, false, METHOD_FORM);
					    n2.attributes = "method";
						n.push(n2);					    
					    x.harmonyMode && (commaOptional = true);
					} else {
						// Support, e.g., |var {x, y} = o| as destructuring shorthand
						// for |var {x: x, y: y} = o|, per proposed JS2/ES4 for JS1.8.
						if (it.peek() !== COMMA && t.peek() !== RIGHT_CURLY)
							throw t.newSyntaxError("missing : after property");
						if (tt !== IDENTIFIER) throw t.newSyntaxError("Property name must be identifier");
						n.push({ type: PROPERTY_INIT, propertyName: id, initializer: id  });
					}
				}
			} while (t.match(COMMA) || commaOptional);
			t.mustMatch(RIGHT_CURLY);
		}
		return n;
    }

    function PropertyName(t, x) {
        var n2, ttn;
		tt = t.token.type;
		switch (tt) {
		  case IDENTIFIER: case NUMBER: case STRING:
			return new Node(t, { type: IDENTIFIER });
		  case LEFT_BRACKET:
		     if (x.ecma3OnlyMode || !x.harmonyMode)  throw t.newSyntaxError("Invalid property name");
		     n2 =Expression(t, x);
             t.mustMatch(RIGHT_BRACKET);
             return n2;
		  default:
		    if (!x.ecma3OnlyMode && t.token.value in definitions.keywords)
		        return new Node(t, { type: IDENTIFIER });
			throw t.newSyntaxError("Invalid property name");
		}     
    }

    
    /*
     * parse :: (file ptr, path, line number) -> node
     */
    function parse(s, f, l) {
        var t = new lexer.Tokenizer(s, f, l);
        var x = new StaticContext(false);
        var n = Script(t, x);
        if (!t.done)
            throw t.newSyntaxError("Syntax error");

        return n;
    }

    return {
        parse: parse,
        Node: Node,
        DECLARED_FORM: DECLARED_FORM,
        EXPRESSED_FORM: EXPRESSED_FORM,
        STATEMENT_FORM: STATEMENT_FORM,
        METHOD_FORM: METHOD_FORM,
        Tokenizer: lexer.Tokenizer,
        FunctionDefinition: FunctionDefinition
    };

}());
