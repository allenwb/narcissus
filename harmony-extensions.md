Experimental Harmony Features
=============================

This version of Narcissus supports the following experimental language extensions. To use these
extensions njs must be invoked using the `-H` switch. Note that Narcissus already supports various
other Harmony features such as `const` and `let` declarations.

## Concise Method Properties in Object Literals
(See <http://wiki.ecmascript.org/doku.php?id=harmony:concise_object_literal_extensions#methods>)

Object literals now have a shorthand for defining data properties that are intended to use as methods.
The shorthand allows the keyword `function` and the colon to be omitted. A
object literal that previously might have been defined as:

    var obj = {
        doSomething: function (arg) {
           arg.doSomethingElse();
        },
        anotherMethod: function() {return "another"}
    };
    
can now be written as:

    var obj = {
        ddoSomething(arg) {
           arg.doSomethingElse();
        },
        anotherMethod() {return "another"}
    };
    
There is an additional difference.  Properties defined in this manner are not enumerable by for-in.
They are also non-writable and non-configurable.

## Comma Optional After Method and Accessor Properties in Object Literals.
(There is not currently an separate Harmony proposal for this feature)

Within an object literal the comma that separates individual property definitions is optional after
method and accessor property definitions.
For example this:

    var obj = {
        a: 0,
        __foo: null,
        someMethod() {
          doSomething();
        }
        get foo() {return __foo}
        set foo(v) {__foo = v}
    }
    
means exactly the same thing as:

    var obj = {
        a: 0,
        __foo: null,
        someMethod() {
          doSomething();
        },  //<-- note comma
        get foo() {return __foo}, //<-- note comma
        set foo(v) {__foo = v}
    }

## The <| Operator
(See <http://wiki.ecmascript.org/doku.php?id=harmony:proto_operator>)

The `<|` operator is use to set the \[\[Prototype\]\] of an object defined using a literal.
The left-hand-side operand can be any value that is convertible to an object or null.
The right-hand-side operand must be a literal.  It may be an object initializer, an array initializer,
a function expression, a numeric literal, a string literal or a boolean literal.

If the LHS operand has a property named `prototype` and the RHS operand is a function expression
then the \[\[Prototype\]\] of the function object is set of the  LHS object and the `prototype` property
of the function is set to a new object whose \[\[Prototype\]\] is the value of the LHS's `prototype`
property.

Example:

    // create a object that inherits from Array prototype
    let XArray = Array.prototype <| {
        fill (value) {for (var i=this.length;i>0;) this[--i]=value}
    };
    
    // create a real array object whose prototype is XArray. It indirectly inherits from
    // Array.prototype
    let a = XArray <| [a,b,c,d,e];
    
    
## super References in Methods
(See <http://wiki.ecmascript.org/doku.php?id=harmony:object_initialiser_super>)

Within a function, the identifier `super` can be used in a manner similar to `this`.  The computational value
of `super` is the same as `this`.  However, property accesses based upon `super` begin their property lookup in the parent object (the object that is the value of
the \[\[Prototype\]\] internal property of the object that owns the method.  This allows an over-ridden inherited method to be called.  For example:

    var obj1 = {doSomething() {return performSomeComputation()}};
    var obj2 = obj1 <| {
        doSomething() {
           beforeAction();
           super.doSomething(); //calls doSomething defined in obj1
           afterAction();
        }
    }
    
`super` property reference can also be made using indexed property notation:
    super[i]();  
    
Functions that reference `super` are directly bound to some specific object that "owns" the function.  Functions defined within an object literal
using a concise method definition, an accessor property definition, or as the initialization value of a data property definition are
owned for `super` lookups to the object created by the object literal.

The Harmony proposal describes a function, `Object.defineMethod`, that can be used to rebind a function containing a `super` reference.  `Object.defineMethod`
has not yet been implemented in this versions of Narcissus.

## Object Extension Literals
(See <https://mail.mozilla.org/pipermail/es-discuss/2011-August/016187.html>)

An object literal based syntax can be used to add additional properties an an already existing object.  For example:

    obj.{
       prop1:1,
       prop2:2
       };

The above expression adds data properties named `prop` and `prop2` to the object `obj`.  If the properties already exist, they are redefined.
An object extension literal may include any form of property definition that may be used in a regular object literal.  Functions referencing `super`
that are defined as property values in an object extension literal are owned by the object that is being extended.

## Computed Property Names in Object Literals

Within an object literal, the value of an expression instead of a literal or identifier can be
used to provide the name for a property definition.  This is accomplished by enclosing the expression
in square brackets.  For example,

    const a = "a";
    const b = "b";
    let obj = {
       [a+b]: "ab",
       [b+a]() {return "ba"}
    };
    
This defines properties named `ab` and `ba` on the object `obj`.

Computed property names primarily exists to support the use of Private Names objects
<http://wiki.ecmascript.org/doku.php?id=harmony:private_name_objects> as property names.
This version of Narcissus does not support Private Names, but they can be simulated in conjunction with the used of computed property names.  For example:

    const Name = function(){
       var counter: 0;
       return {create() {return "private name "+ counter++}}
    }();
    
    const myPrivate = Name.create();
    let obj = {
       [myPrivate]: 0,
       someMethod(x) {return doSomthing(x,this[myPrivate]}
    };
    
    