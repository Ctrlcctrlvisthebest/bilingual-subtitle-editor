(function () {
  'use strict';
  if (!Array.prototype.at) Object.defineProperty(Array.prototype, 'at', {configurable:true, writable:true, value:function (index) {
    var n = Number(index) || 0;
    n = n < 0 ? Math.ceil(n) : Math.floor(n);
    return this[n < 0 ? this.length + n : n];
  }});
  if (!Object.fromEntries) Object.fromEntries = function (entries) {
    var result = {};
    for (var pair of entries) Object.defineProperty(result, pair[0], {value:pair[1], enumerable:true, configurable:true, writable:true});
    return result;
  };
  if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) Element.prototype.replaceChildren = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
    for (var i = 0; i < arguments.length; i++) this.appendChild(arguments[i]);
  };
}());
