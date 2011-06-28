// vim: set sw=4 ts=4 fdm=marker et :
//"use strict";
var INFO = //{{{
<plugin name="piyo-ui" version="0.1.1"
        href="http://github.com/caisui/vimperator/blob/master/plugin/piyo-ui.js"
        summary="piyo ui"
        xmlns="http://vimperator.org/namespaces/liberator">
    <author href="http://d.hatena.ne.jp/caisui">caisui</author>
    <license href="http://www.opensource.org/licenses/bsd-license.php">New BSD License</license>
    <project name="Vimperator" minVersion="3.0"/>
    <item>
        <description>
            以下の機能を提供する UIです。
            - 一覧の列挙
            - 列挙したものを絞り込む
            - 一覧から選択したものに対してコマンドを実行

<![CDATA[
ToDo:
- fold 機能
- stack 型多段 piyo
- 複数の sourceに 跨ぐ選択状態での command
- 折り返されずに文字が画面外にでる
- word ハイライト(not 絞り込み)
- view の 部分更新
- 個別 source 専用 stylesheet
-- 自source 以外には反映されない仕組み
- source を他 plugin から 拡張する手段
- 単一選択用/複数選択用 map/command を 認識できる手段
- 固有 map 一覧の確認方法
- Deferred っぽい仕組み
-- test 中
- util.http.post の 実装
- item 生成用に 略記関数(wiki記法とか、zen codingのような)
- modes.reset への 対応策
- vim の quickfix のような表示方法


Bug:
- 高さ調整が上手くいかないパターンがある
- 表示候補数0でmap, commandが 動かない


Done:
- 下部の余白に「~」
- source 固有map
- command
- 疑似非同期 item 列挙
- 絞り込み検索
- 否定検索
]]>
        </description>
    </item>
</plugin>;
//}}}

let interval = liberator.globalVariables.piyo_interval || 500;

/**
 * @param {Object}  cocnsole log
 */
function log() //{{{
{
    let msg = Cc["@mozilla.org/scripterror;1"].createInstance(Ci.nsIScriptError);
    let stack = Components.stack.caller;
    //let category = "PIYO " + (new Date()).toLocaleFormat("%y.%m.%d-%H:%M:%S");
    //let category = "PIYO " + (new Date()).toLocaleFormat("%m%d %H:%M:%S");
    let category = "PIYO";
    let message = Array.concat((new Date()).toLocaleFormat("%m%d %H:%M:%S"), Array.splice(arguments, 0));
    msg.init(message, stack.filename, stack.sourceLine, stack.lineNumber, null, 0, category);
    services.get("console").logMessage(msg);
}//}}}

function lazyGetter(obj, name, func) {
    obj.__defineGetter__(name, function () {
        delete this[name];
        return this[name] = func.call(obj);
    });
}

function lazyGetterSrvc(obj, name, classID, interface) {
    obj.__defineGetter__(name, function() {
        delete this[name];
        return this[name] = Cc[classID].getService(interface);
    });
}

/**
 * @param {Object}
 * @param {Object}
 */
function nullOr(value, defaultValue) value === null ? defaultValue : value

let stopWatch = {
    start: function () this.t = Date.now(),
    end: function () log(Array.concat(Date.now() - this.t, Array.splice(arguments, 0)))
};

let fx3 = Application.version[0] === "3";
let disabledFixed = liberator.globalVariables.piyo_disabled_fixed;
let piyo = this;

function DelayTimer(self, minInterval, callback) //{{{
{
    let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    return {
        notify: function (aTimer) {
            timer.cancel();
            this.doneAt = Date.now();
            callback.apply(self, this.args);
        },
        tell:function () {
            if (this.doneAt === -1)
                timer.cancel();

            this.args = Array.splice(arguments, 0);

            timer.initWithCallback(this, minInterval, timer.TYPE_ONE_SHOT);
            this.doneAt = -1;
        },
        reset: function () {
            timer.cancel();
            this.doneAt = 0;
        },
        flush: function () {
            if (this.doneAt === -1) {
                this.args = Array.splice(arguments, 0);
                this.notify();
            }
        }
    };
}//}}}


lazyGetter(this, "Deferred", function () //{{{
{
    // 参考: https://github.com/cho45/jsdeferred/
    var uuid = 0;
    function Deferred(func) {
        if (this instanceof Deferred) {
            //xxx: debug
            //log("-----------------create instance");
            this.init(func);
            this.uuid = ++uuid;
        } else
            return new Deferred(func);
    };
    var D = Deferred;

    D.prototype = {
        init: function (canceller) {
            this._canceller = canceller;
            this._callbacks = [];
            this._state = 0;
            this._parent = null;
            this._nest = null;
            this._result = null;
            this._msg = "ok";
            return this;
        },

        next:  function (callback) this._post({ok:callback}),
        error: function (callback) this._post({ng:callback}),
        both:  function (callback) this._post({ok:callback, ng:callback}),
        scope: function (callback) {callback(); return this;},

        call: function (value) {
            //log("** fire", this.uuid);
            this._msg = "ok";
            return this._fire(value)
        },
        fail: function (value) {
            this._msg = "ng";
            return this._fire(value);
        },

        // xxx: debug
        //get _msg ()  this.__msg,
        //set _msg (v) {
        //    this.__msg = v;
        //},

        _post: function (obj) {
            //if (this._nest) throw "it's runngin. cannot push action";
            this._callbacks.push(obj);

            if (this._state == Deferred.DONE) {
                var self = this.init();
                Deferred.next(function () self);
            } 
            return this;
        },

        fire: function (value) {
            return this._fire(value);
        },

        // debug
        get _depth() {
            let count = 0, p = this;
            while (p = p._parent) count++;
            return count;
        },
        _fire: function (value) {
            var callbacks = this._callbacks;
            var callback;

            while (callback = callbacks.shift()) {
                try {
                    var f = callback[this._msg];
                    if (!f) continue;
                    var result = f.call(this, value);

                    if (this._breaker) {
                        var breaker = this._breaker;
                        this._breaker = null;
                        Deferred.lazyCall(breaker);
                        return;
                    }
                        
                    if (result instanceof Deferred) {
                        this._nest = result;
                        result._msg = this._msg;
                        result._parent = this;
                        // xxx: return this; //?
                        return;
                    } else
                        value = result;
                } catch (ex) {
                    this._msg = "ng";
                    Cu.reportError(ex);
                    this._result = value = ex;
                }
            }

            var parent = this._parent;
            if (parent) {
                this._parent = parent._nest= null;
                parent._msg = this._msg;
                return parent._fire(value);
            } else
                return this;
        },

        cancel: function () {
            log("cancel");
            var d;
            let list = [];
            const self = this;
            ["_parent", "_nest"].forEach(function (attr) {
                for (d = self[attr]; d; d = d[attr]) {
                    list.push(d);
                }
            });
            this._nest ? this._nest.cancel() : this._canceller && this._canceller();
            return 
        },

        pause:  function () this._nest ? this._nest.pause()  : this._breaker = Deferred.new(),
        resume: function () this._nest ? this._nest.resume() : this._fire(this._result),
    };

    D.PREPARE = {};
    D.RUNNING = {};
    D.DONE = {};

    D.next_image = function (callback) {
        var img = new Image();
        var d = Deferred.domEvent(img, "error");
        var t = Date.now();
        img.src = "data:image/png," + Math.random();
        return d
        .next(function (){log("im", Date.now()-t);})
        .next(callback);
    };
    D.next_timeout = function (callback) {
        var id = setTimeout(function () {d.call()}, 0);
        var d = new Deferred(function () {clearTimeout(id);});
        var t = Date.now();
        return d
        .next(function (){log("to", Date.now()-t);})
        .next(callback);
    };
    D.next_timer = function (callback) {
        var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        var d = new Deferred(function () { timer.cancel(); });
        var t = Date.now();
        timer.initWithCallback({ notify: function (){d.call();}}, 0, Ci.nsITimer.TYPE_ONE_SHOT);
        return d
        .next(function (){log("tm", Date.now()-t);})
        .next(callback);
    };
    D.next = D.next_timer;

    //D.classID = D.prototype.classID = 0x5e7ab100c2e51;
    D.lazyCall = function (deferred, value)
        Deferred.wait(0).next(function () deferred.call(value));
    D.wait = function wait(msec) {
        var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        var d = new Deferred(function () { timer.cancel(); });
        timer.initWithCallback({ notify: function () d.call()}, msec, Ci.nsITimer.TYPE_ONE_SHOT);

        return d;
    };
    D.domEvent = function (dom, event, capture) {
        if (capture == void 0) capture = false;
        var d = new Deferred(cancel);
        d.name = "domEvent";
        dom.addEventListener(event, callback, capture);
        function cancel() {
            dom.removeEventListener(event, callback, capture);
        }
        function callback(e) {cancel(); d.fire(e); }
        return d;
    };
    D.httpGet = function (url, query) {
        var d = new Deferred();
        var xhr = new XMLHttpRequest();
        var d1 = Deferred.domEvent(xhr, "readystatechange").next(function (e) d2.cancel() && d.call(xhr));
        var d2 = Deferred.domEvent(xhr, "error").next(function (e) d1.cancel() && d.fail(xhr));
        xhr.send(url);

        return d;
    };
    D.new = function (canceller) {
        var d = new Deferred(canceller);
        return d;
    };
    D.parallel = function (list) {
        if (arguments.length > 1) list = Array.slice(arguments);
        var obj = {}, count = list.length, results;
        var d = new Deferred(cancel);
        list.forEach(function (d, i) {
            if (typeof (d) == "function") d =  Deferred.next(d);
            obj[i] = new Deferred(cancel).next(function () d)
                .both(function (val) {
                    delete objs[i];
                    return val;
                })
                .next(function (val) {
                    results[i] = val;
                    if (--count <= 0)
                        d.call(results);
                })
                .error(function (ex) {
                    cancel();
                    d.fail(ex);
                });
            ;
        });
        function cancel() {
            for (let a in obj)
                obj[a].cancel();
        }
        return d;
    };
    D.iter = function _iter(iter, callback) {
        var d = new Deferred(function () {
            if (iter.close) iter.close();
            return d1.cancel();
            return d1.cancel()
            .next(function () {
                if (iter.close) iter.close();
            });
        });

        if (iter instanceof Function) iter = iter();
        else if (iter instanceof Array) iter = Iterator(iter);
        //else if (iter instanceof Iterator) 

        var param = {iter: iter};
        var d1 = Deferred.next(function loop (value) {
            try {
                param.result = value;
                param.value = iter.next();

                return d1 = Deferred.next(function () {
                        let r = callback.call(this, param)
                        return r;
                    })
                    .next(loop)
                    .error(function (ex) {
                        Cu.reportError(ex);
                        d.fail(ex);
                    });
            } catch (ex if ex instanceof StopIteration) {
                    d.call(value);
            } catch (ex) {
                    d.fail(ex);
            }
        });
        return d;
    };
    ["wait", "iter"].forEach(function (name) {
        D.prototype[name] = function () {
            let args = Array.slice(arguments);
            return this
                .next(function (preValue) D[name].apply(D, args).next(function (value) [value, preValue]));
        };
    });
    function echmsg(msg) { return function () {
        liberator.echo(msg);
        log(msg);
    };}
    return D;
}); //}}}

let PiyoCommands = Class("PiyoCommands", Commands, //{{{
{
    init: function (array) {
        if (array instanceof Array) {
            let ignore = [];
            this._exCommands = Array.concat(array).filter(function (c) {
                if (c instanceof PiyoGuardCommand) {
                    ignore.push(c);
                    return false;
                } else return !ignore.some(function (cmd) c.hasName(cmd.name));
            });
        } else this._exCommands = [];
    },
    completer: function (context) {
        if (Command.prototype.subCommands)
            completion.ex(context, this._exCommands)
        else
            this.ex.call({
                __proto__: completion,
                command: this.command
            }, context);
    },
    addGuadCommand: function (spec) this._addCommand(PiyoGuardCommand(spec))
}, {
    commonCommands: function (commands) {
        if (commands.length === 0) return PiyoCommands();
        else if(commands.length === 1) return commands[0]; // XXX: PiyoCommand(commands[0]._exCommands)?

        let exCommands = commands.map(function (c) c._exCommands);
        let top = exCommands.pop();
        let exCommand = top.filter(function (me) exCommands.some(function (other) other.hasName(me.name)));
        return PiyoCommands(exCommand);
    }
}); //}}}

let PiyoGuardCommand = Class("PiyoGuardCommand", //{{{
{
    init: Command.prototype.init,
    hasName: Command.prototype.hasName
}); //}}}

PiyoCommands.prototype.__defineGetter__("ex", function () {
    let func = liberator.eval(<![CDATA[(function() base)()]]>.toString()
        .replace("base", completion.ex.toString()), {commands: this});
    this.__defineGetter__("ex", function() func);
    return func;
});
PiyoCommands.prototype.__defineGetter__("command", function () {
    let func = liberator.eval(<![CDATA[(function() base)()]]>.toString()
        .replace("base", completion.command.toString()), {commands: this});
    this.__defineGetter__("command", function() func);
    return func;
});
PiyoCommands.prototype.__defineGetter__("execute", function () {
    let func = liberator.eval(<![CDATA[(function() base)()]]>.toString()
        .replace("base", liberator.execute.toString()), {commands: this});
    let exe = function (args, modifiers) {
        func(args, modifiers, true);
    }
    this.__defineGetter__("execute", function() exe);
    return exe;
});
let PMap = fx3 ? function () Map.apply(this, [[modes.PIYO]].concat(Array.slice(arguments))) : Map.bind(this, [modes.PIYO]);

let PiyoUI = Class("PiyoUI", //{{{
{
    init: function (iframe, editor) {
        this.iframe = iframe;
        this._aliases = [];
        this._sources = [];
        this._stack = [];
        this._contexts = [];
        this.keep = false;
        this.original = "";
        this._index = 0;
        this.editor = editor;
        this.items = [];
        this._filter = "";
        this._scripts = {};
        this._cache = {};
        this.async = true;

        function NOP() void 0
        this.__defineGetter__("NOP", function() NOP);

        let self = this;
        this._updateTimer = DelayTimer(this, 300, function () {
            if (this.filter.trim() !== this._filter.trim()) {
                //this.openAsync(this.original, this.editor.value, this.modifiers);
                this._buildItems(this.editor.value, this._source, this.modifiers);
            }
        });

        this._resizer = new Timer(0, 300, function (force) {
            let box = self.box;
            //if (force || box.style.height !== "0pt") {
                var docHeight = Math.min(self.doc.documentElement.scrollHeight, 0.7 * window.innerHeight);
                var maxHeight = parseFloat(box.style.maxHeight) || 0;
                if (maxHeight < docHeight) {
                    //box.style.height = self.doc.height + "px";
                    box.style.maxHeight = docHeight + "px";
                }
            //}
        });
        this._updateStatus = new Timer(200, 500, function () {
            self.updateStatus();
        });
    },
    get doc() this.iframe.contentDocument,
    get box() this.iframe.parentNode,
    get filter() this.editor.value,
    get index() this._index,
    set index(value) {
        this._index = value;
        let item = this.items[value];
        if (!item) return;
        mappings._user[modes.PIYO] = item.source.maps;
    },
    get selectedItem() this.items[this.index],
    get style() //{{{
        <![CDATA[
            * {
                margin: 0;
                padding: 0;
            }
            body * {
                padding: 1px 2px;
            }
            .item > * {
                min-height: 3ex;
            }
            .item {
                background: rgba(255,255,255,.9);
            }
            /*.item:nth-child(even) {
                background: rgba(244,244,244,.9);
            }*/
            .item.odd {
                background: rgba(244,244,244,.9);
            }
            /*xxx: [selected]?*/
            .item[selected] {
                background: rgba(255,236,139,.9);
            }
            .mark {
                padding-left: 1ex;
                min-width: 1ex;
                max-width: 1ex;
                font-weight: bold;
                color: blue;
            }
            span.mark {
                display: inline-block;
                min-height: 0ex;
            }
            .ib {
                display:inline-block;
            }
            .title {
                text-align: left;
                font-weight: bold;
                /*background: -moz-linear-gradient(19% 75% 90deg, #DBDBDB, #D9D9D9, #E7E7E7 100%);*/
                background: -moz-linear-gradient(19% 75% 90deg, rgba(219,219,219,.9), rgba(217,217,217,.9), rgba(231,231,231,.9) 100%);

                padding: 0.5ex;
                width: 100%;
            }
            .nw {
                white-space: nowrap;
            }
            .wwb {
                word-wrap:break-word;
            }
            #main {
                width: 100%;
                padding: 0;
                margin: 0;
            }
            #bottom {
                position: fixed;
                width: 100%;
                height: 100%;
                background-color: rgba(128,128,128,.5);
                color: blue;
                font-weight: bold;
            }
        ]]> + (liberator.globalVariables.piyo_style || ""), //}}}
    open: function (source, input, modifiers) //{{{
    {}, //}}}
    openAsync: function openAsync(source, input, modifiers) {
        if (this.build) {
            log("start", this.filter, this.build);
            this.abort = {
                type: "filter",
                args: Array.splice(arguments, 0)
            };
            return;
        }
        this.generatorAsync (source, input, modifiers);
    },
    abortAction: function () {
        let inf = this.abort;
        this.abort = null;
        switch(inf.type) {
        case "filter":
            this.openAsync.apply(this, inf.args);
            break;
        case "quit":
            this.quit();
            break;
        }
    },
    generatorAsync: function generatorAsync(source, input, modifiers) //{{{
    {
        const self = this;

        this.original = source;

        function _createSource(self, names) {
            for (var [, name] in Iterator(names)) {
                if (self._aliases[name]) {
                    self._aliases[name].forEach(_createSource);
                    for (var source in _createSource(self, self._aliases[name]))
                        yield source;
                } else {
                    yield self._sources[name];
                }
            }
        }
        this.editor.value = input || "";
        //this.setTimeout(function () _createItem.call(self, self, _createSource(self, source.split(" "))), 0);
        this._buildItems(input, function () _createSource(self, source.split(" ")), modifiers);
    },//}}}
    list: function (input, source) {
        log("list function is renamed input");
        this.input(input, source);
    },
    input: function (input, source) {
        if (!input) input = "";
        this.editor.value = input;
        let creator = this.createSource("anonymouse", source);
        this._buildItems(input, function () {yield creator;});
    },
    push: function (input, source, modifiers) {
        const self = this;
        this._stack.push(
        // xxx: 現仕様では、_source から 再作成する必要があるため、_contexts, items, index は 再利用できない
        ["_filter", "_source", "_cache",
            //"_contexts", "items", "index"
        ].reduce(function (obj, name) {
            obj[name] = self[name];
            return obj;
        }, {}));
        // cache の クリア
        this._cache = {};
        this.input(input, source, modifiers);
    },
    pop: function () {
        const self = this;
        for (let[name, value] in Iterator(this._stack.pop()))
            this[name] = value;
        this.editor.value = this._filter;
        this._buildItems(this._filter, this._source, null);
    },
    showBox: function () {
        this.setTimeout(function () {
            let iframe = this.iframe;
            let box = this.box;

            if (box.collapsed == true && !disabledFixed) {
                let (r = commandline._commandlineWidget.parentNode.getBoundingClientRect()) {
                    box.style.bottom = r.height + "px";
                }
                this.box.collapsed = false;
            }
            if (this.index === -1 && this.items.length > 0) {
                this.index = 0;
                this.selectedItem.select();
                window.setTimeout(function ()
                    util.nodeScrollIntoView(self.iframe.contentDocument.body), 0);
            }
        }, 0);
    },
    initUI: function () {
        // init ui
        let doc = this.doc;
        let style = doc.createElement("style");
        let main = doc.createElement("div");
        let bottom = doc.createElement("pre");
        style.innerHTML = this.style;

        main.id = "main";
        bottom.id = "bottom";
        bottom.appendChild(doc.createTextNode((new Array(100)).join("~\n")));
        doc.body.id = "liberator-piyo-body";

        doc.body.appendChild(style);
        doc.body.appendChild(main);
        doc.body.appendChild(bottom);
    },
    _buildItems: function _buildItems(filter, sourceGenerator, modifiers) {
        const self = this;
        const thread = services.get("threadManager").mainThread;
        self._deferred = null;

        if (!modifiers) modifiers = {};
        if ([modes.PIYO, modes.PIYO_I].indexOf(liberator.mode) < 0)
            modes.set(modes.PIYO);

        this.modifiers = modifiers;

        try {
            this.tid = 0;
            this.abort = false;
            this.build = true;

            this._contexts = [];
            this.items = [];
            this.index = -1;
            this._filter = filter;
            this._source = sourceGenerator;

            let doc = this.doc;
            let main = doc.getElementById("main");
            let async = this.async;
            //if (this.box.collapsed) {
                main.innerHTML = "";
            //}

            let duration = Date.now();
            item_generator: for (let source in sourceGenerator()) {
                let items = [];
                let context = source(source.name, this);
                this._contexts.push(context);

                // view
                let root = util.xmlToDom(context.createRoot(), doc);
                let (title = root.querySelector(".title")) {
                    if (title) title.textContent = context.title || "no name";
                }
                //doc.body.appendChild(root);
                main.appendChild(root);
                let (node = root.querySelector(".content")) {
                    if (node) root = node;
                    else root.classList.add("content");
                }

                let node = doc.createDocumentFragment();
                context.filter = filter;
                let highlighter = context.getHighlighter(filter);

                let iterItem = context.generator(self);
                if (iterItem instanceof Array) {
                    iterItem = util.Array.itervalues(iterItem);
                }

                // items offset
                context.offset = items.length;
                let nextUpdate = Date.now() + interval;
                let max = 0, cnt = 0, min = Infinity;
                for (let item in iterItem) {
                    var aCnt = 0;

                    if (async)
                        while (thread.processNextEvent(false)) aCnt ++;
                    max = Math.max(max, aCnt);
                    min = Math.min(min, aCnt);
                    cnt += aCnt;
                    if (self.abort) {
                        log("abort", self.abort);
                        iterItem.close();
                        self.setTimeout(function () {
                            this.abortAction();
                        }, 0);
                        break item_generator;
                    }
                    context.items.push(item);
                    let hi = highlighter(item);
                    if (hi) {
                        let view = util.xmlToDom(context.createView(item, highlighter(item)), doc);
                        //let view = xmlToDom(context.createView(item, highlighter(item)), doc);
                        view.classList.add("item");
                        node.appendChild(view);
                        items.push(PiyoItem(item, view, context));

                        let max = 1, len = self.items.length;
                        if (len > 1000) {
                            max = 500;
                        } else if (len > 20) {
                            max = 100;
                        }
                        if ((Date.now() - duration > 500) && node.childNodes.length > max) {
                            root.appendChild(node);
                            node = doc.createDocumentFragment();
                            self.items = Array.concat(self.items || [], items);
                            items = [];

                            if (self.index === -1) {
                                this.showBox();
                            }

                            self._resizer.tell();
                            self._updateStatus.tell();
                            duration = Date.now();
                        }
                    }
                }
                root.appendChild(node);
                self.items = Array.concat(self.items || [], items);
            }
            if (this._contexts.length === 0) {
                self.echoerr("no create sources");
                return;
            }
        } finally {
            this.build = false;

            if (this.abort) return;

            this._updateStatus.tell();
            this._resizer.tell();
            this.showBox();
        }
    },
    hide: function () {
        //window.setTimeout(function () ui.box.collapsed = true, 0);
    },
    refresh: function () this.openAsync(this.original, this.filter, this.modifiers),
    quit: function () {
        if (this.build) {
            this.abort = {
                type: "quit",
            };
            return;
        }
        this._resizer.reset();
        this._updateTimer.reset();
        this.modifiers = {};
        this._cache = {};
        this.hide();
        window.setTimeout(function() {
            ui.box.collapsed = true
            ui.box.style.maxHeight = 0;
            //liberator.threadYield(true);
            modes.reset();
        }, 0);
    },
    createContext: function (source, offset, proto) {
        if (typeof(source) === "string")
            source = this._sources[source];
        let context = source();
        if (proto) {
            update(context, proto);
        }
        context.filter = this.filter.substr(offset);
        context.ui = this;
        context.createItem(this);
        this._contexts.push(context);
        return context;
    },
    createSource: function (name, base, prop) {
        if (!prop) [base, prop] = [PiyoSource, base];
        else if (typeof(base) === "string") {
            let baseProto = this._sources[base];
            if (!baseProto) {
                liberator.echoerr(<>{base} is not found!</>);
                return;
            }
            base = baseProto;
        }
        let prop1 = {abstract: prop.abstract || false};
        delete prop.abstract;

        if (prop.commands) {
            if (prop.commands instanceof Function) {
                let commands = PiyoCommands();
                prop.commands(commands);
                prop.commands = commands;
            } else if (prop.commands instanceof Array) {
                prop.commands = PiyoCommands(prop.commands);
            } else {
                liberator.echoerr(name);
            }
        }

        return Class(name, base, prop, prop1);
    },
    registerSource: function (name, base, prop) {
        this._sources[name] = this.createSource(name, base, prop);
    },
    unregisterSource: function (name) {
        delete this._sources[name];
    },
    scroll: function (index, relative) {
        if (this.index === -1) return;
        if (relative) index += this.index;
        else if (index < 0) index = this.items.length - 1;
        else index = index - 1;
        index = Math.max(0, Math.min(this.items.length - 1, index));

        let item = this.selectedItem;
        if (!item) return;
        item.unselect();

        item = this.items[this.index = index];
        item.select();
        util.nodeScrollIntoView(item.view, -1, -1);

        if (liberator.mode === modes.PIYO)
            modes.show();
    },
    scrollByPages: function (count) {
        let win = this.iframe.contentWindow;
        win.scrollByPages(count);

        let e = this.doc.elementFromPoint(4, count < 0 ? 4 : win.innerHeight - 4);
        while (e && e.classList && !e.classList.contains("item"))
            e = e.parentNode;

        // todo: caption
        let self = this;
        e && this.items.some(function (item, n) {
            if (item.view === e) {
                self.selectedItem.unselect();
                self.index = n;
                item.select();
                util.nodeScrollIntoView(e, -1, -1);

                if (liberator.mode === modes.PIYO)
                    modes.show();
                return true;
            }
            return false;
        });
    },
    addAlias: function (name, aliases) {
        this._aliases[name] = aliases;
    },
    getMarkedOrSelectedItem: function () {
        let source = this.selectedItem.source;
        let result = this.items.filter(function (i) i.source == source && i.mark);
        return result.length > 0 ? result : [this.selectedItem];
    },
    execute: function (command, modifiers) {
        if (!modifiers) modifiers = this.modifiers;
        let self = this;
        let executed = this._contexts.reduce(function (a, source) {
            modifiers.items= self.items.filter(function (i) i.source === source && i.mark);
            if (modifiers.items.length)
                source.execute(command, modifiers);
            return a || modifiers.items.length > 0;
        }, false);
        if (!executed) {
            let item = this.selectedItem;
            modifiers.items = [item];
            item.source.execute(command, modifiers);
        }

        if (!modifiers.noquit)
            this.quit();
        else {
            commandline._setCommand(filter);
            ui._buildItems(filter, ui._source, ui.modifiers);
        }
    },
    showHelp: function () {
        //let source = this.selectedItem.source;
        //for (let attr in source.marks) {
        //    liberator.echo(attr);
        //}
        modes._prevMode = modes.PIYO;
        let item = this.selectedItem.item;
        if (item.item) item = item.item;
        liberator.echo(util.objectToString(item, true));
    },
    selectAll: function (isAll) {
        let mark = !this.items.some(function (i) i.mark);
        this.items.forEach(function (i) i.mark = mark);
    },
    selectReverse: function (isAll) {
        let source = this.selectedItem.source;
        (isAll ? this.items : this.items.filter(function (i) i.source === source))
            .forEach(function (i) i.toggleMark());
    },
    loadPiyo: function (file) {
        if (typeof(file) === "string") file = io.File(file);
        if (!/\.piyo$/.test(file.leafName) || !file.isFile()) return;
        let uri = services.get("io").newFileURI(file);
        let name = file.leafName;

        let script;
        try {
            if ((name in (this._scripts))) {
                if (this._scripts[name].hasOwnProperty("onUnload"))
                    this._scripts[name].onUnload();
            }

            script = {__proto__: piyo};
            log(<>load plugin: {file.leafName}</>);
            liberator.loadScript(uri.spec, script);
            this._scripts[name] = script;
        } catch (ex) {
            Cu.reportError(ex);
            liberator.echoerr(ex);
        }
    },
    loadPiyos: function () {
        let dir = io.File(piyo.PATH).parent;
        dir.append("piyo");
        dir = io.File(dir);
        let self = this;;
        if (dir.exists() && dir.isDirectory()) {
            dir.readDirectory().forEach(function(f) self.loadPiyo(f));
        }
    },
    getCommands: function () {
        let items = ui.items;
        let commands = this._contexts.filter(function (c) {
                for(let i = c.offset, last = c.itemLength - c.offset; i < last; ++i) {
                    if (items[i].mark) return true;
                }
                return false;
            }).map(function (c) c._commands);
        return PiyoCommands.commonCommands(commands.length ? commands : [ui.selectedItem.source._commands]);
    },
    forceReset: function () {
        this.build = false;
        let f = this.abort;
        try {
            this.abortAction();
        } finally {
            this.abort = null;
        }
    },
    echo: function () {
        // required check modes.PIYO?
        
        modes._prevMode = modes.PIYO;
        liberator.echo.apply(liberator, arguments);
    },
    echoAsync:    function () let(args = Array.splice(arguments, 0)) this.setTimeout(function () liberator.echo.apply(liberator, args), 0),
    echoerr: function () let(args = Array.splice(arguments, 0)) this.setTimeout(function () liberator.echoerr.apply(liberator, args), 0),
    get rowStateE4X() <>[{this.index + 1}/{this.items.length}{this.build ? "*" : ""}]</>,
    updateStatus: function () {
        if (liberator.mode == modes.PIYO) {
            modes.show();
        } else {
            commandline._setPrompt(this.rowStateE4X.toString());
        }
    },
    openAsync: function (source, value) {
        this.dOpen(source, value);
    },
    dOpen: function (source, value) {
        const self = this;
        this._deferred = Deferred
            .next(function () {
                return self.dfOpen(source, value);
            })
            .error(function(ex) {
                liberator.echoerr(ex);
                Cu.reportError(ex);
            });
    },
    dfOpen: function (source, value) {
        if (typeof source == "string") {
            source = source.split(" ");
        }
        let contexts = [];
        function _createSource(self, names) {
            for (var [, name] in Iterator(names)) {
                if (self._aliases[name]) {
                    self._aliases[name].forEach(_createSource);
                    for (var source in _createSource(self, self._aliases[name]))
                        yield source;
                } else {
                    yield self._sources[name];
                }
            }
        }

        if (!value) value = "";
        this._contexts = [s(s.name, this) for (s in _createSource(this, source))];
        this._filter = value;
        this.editor.value = value;
        modes.set(modes.PIYO);
        this.modifiers = {};
        return this.dfShow();
    },
    input: function (input, source) {
        this.dfInput(source, input);
    },
    dfInput: function (source, input) {
        if (fx3) modes.set(modes.PIYO);
        else
        modes._prevMode = modes.PIYO;
        this.editor.value = "";
        this._filter = input || "";
        this.modifiers = {};
        this._contexts = [this.createSource("anonymouse", source)("anonymouse", this)];
        return this._deferred = this.dfShow();
    },
    refresh: function() {
        this._deferred = this.dfShow();
    },
    dfRefresFilter: function () {
        if (this._filter == this.editor.value) return;
        const self = this;
        this._deferred.cancel();
        this._deferred = Deferred.wait(300)
        .next(function () {
            self._filter = ui.editor.value;
        })
        .next(function () self.dfShow())
        .error(function (ex) alert(ex));
    },
    dfShow: function () {
        const self = this;
        let items = this.items = [];
        return Deferred
        .next(function () {
            self.index = -1;
            let doc = self.doc;
            let main = doc.getElementById("main");
            let r = doc.createRange();
            r.selectNodeContents(main);
            r.deleteContents()
        }).iter(this._contexts, function (param) {
            let [,context] = param.value;
            let doc = self.doc;
            let main = doc.getElementById("main");

            let root = util.xmlToDom(context.createRoot(), doc);
            let (title = root.querySelector(".title")) {
                if (title) title.textContent = "[df] " + (context.title || "no name");
            }

            main.appendChild(root);
            let (node = root.querySelector(".content")) {
                if (node) root = node;
                else root.classList.add("content");
            }
            //
            // items offset
            context.offset = items.length;
            let node = doc.createDocumentFragment();

            function updateItem() {
                root.appendChild(node);
                node = doc.createDocumentFragment();

                for (let i = 0, j = list.length; i < j; ++i)
                    items[items.length] = list[i];
                list = [];

                if (self.index === -1) {
                    self.showBox();
                }

                self._resizer.tell();
                self._updateStatus.tell();
            }

            context.filter = self._filter;
            let iter = context.generator(self);
            let highlighter = context.getHighlighter(self._filter);
            let isOdd = 1;
            let list = [];

            return Deferred.next(function(){})
            .iter(iter, function (param) {
                let item = param.value;
                //for (let item = param.value, time = Date.now() + 100; Date.now() < time; item = param.iter.next()) {
                let (item = param.value) {

                    context.items.push(item);
                    let hi = highlighter(item);
                    if (hi) {
                        let view = util.xmlToDom(context.createView(item, hi), doc);
                        view.classList.add("item");
                        if (isOdd) {
                            view.classList.add("odd");
                        }
                        isOdd ^= 1;
                        node.appendChild(view);
                        list[list.length] = PiyoItem(item, view, context);
                    }
                }

                if (node.childNodes.length > 500) {
                    updateItem();
                }
            })
            .next(updateItem);
        })
        .next(function (e) {
            log("end");
        })
        .error(function (ex) {
            liberator.echoerr(ex);
            Cu.reportError(ex);
        })
        ;
    },
}, {
}); //}}}

let PiyoSource = Class("PiyoSource", //{{{
{
    init: function (name, ui) {
        this.items  = [];

        if (this.onLoad) this.onLoad();

        this._cache = ui._cache[name] || (ui._cache[name] = {});

        let stack = [];
        let self = this;
        while (self) {
            if (self.hasOwnProperty("commands")) {
                stack.push(self.commands._exCommands);
                if (self.commands.stop)
                    break;
            }
            self = self.__proto__;
        }
        this._commands = PiyoCommands(Array.concat.apply(0, stack));
    },
    //createRoot: function () <table style="border-collapse:collapse;"><caption class="title"/><tbody class="content">
    //<style><![CDATA[tr.item>td:last-child{width:100%;}]]></style>
    //</tbody></table>,
    createRoot: function () <table style="border-collapse:collapse;"><style><![CDATA[tr>td:last-child{width:100%;}]]></style><caption class="title"/></table>,
    getHighlighter: function () {
        let filter = this.filter.trim();
        let keys = this.keys;
        if (keys.length === 0 || filter.length === 0)
            return function (item) {
                let val = {};
                keys.forEach(function (key) {
                    val[key] = let (x = item[key]) x instanceof Array ? x[0] : x;
                });
                return val;
            };
        // required [{pos,len},...]
        let matchers = filter.split(" ")
            .map(this.matcher || util.regexpMatcher2);
        let self = this;
        return function (item) {
            let hi_pos = {};
            let count = 0;

            function iterWords(item, keys) {
                let ret = {};
                let max = keys.length - 1;
                let stack = [];
                let top;

                function keyValueEach(index) {
                    let key = keys[index];
                    for (let [, val] in Iterator(Array.concat(item[key] || ""))) {
                        ret[key] = val;
                        yield 1;
                    }
                    yield 0;
                }

                top = keyValueEach(stack.length);
                while (1) {
                    if (stack.length === max) {
                        for(let r in top) if (r) yield ret;
                        if (stack.length === 0) break;
                        top = stack.pop();
                    } else {
                        if (top.next()) {
                            stack.push(top);
                            top = keyValueEach(stack.length);
                        }
                        else if (stack.length === 0) break;
                        else top = stack.pop();
                    }
                }
            }
            let proto = let(e=[]) keys.reduce(function (r, v) {r[v] = e; return r;}, {});
            for (let val in iterWords(item, keys)) {
                let ret = {__proto__: proto};
                let isMatch = !matchers.some(function (matcher) {
                    let isMatch = false;
                    for (let [attr, text] in Iterator(val)) {
                        if (matcher.exclude) {
                            if (matcher(text))
                                return true;
                            isMatch = true;
                        } else {
                            let pos = matcher(text);
                            if (pos.length > 0) {
                                ret[attr] = ret[attr].concat(pos);
                                isMatch = true;
                            }
                        }
                    }
                    return !isMatch;
                });
                if (isMatch) {
                    let hi = {};
                    for (let [attr, text] in Iterator(val)) {
                        let a = ret[attr];
                        a.sort(function (a, b) a.pos - b.pos);
                        if (fx3) {
                            a = (function (a) {
                                for (let [, {pos: pos, len: len}] in Iterator(a)) yield [pos, len];
                            })(a);
                        }
                        hi[attr] = template.highlightSubstrings(text, a, template.filter);
                    }
                    return hi;
                }
            }
            return null;
        };
    },
    getCache: function (name, func) {
        return this._cache[name] || (this._cache[name] = (func || Object).call(this));
    },
    setCache: function (name, obj) this._cache[name] = obj,
    iterCache: function (name, iter) {
        let cache = this._cache[name];
        if (cache) {
            for (let [, obj] in Iterator(cache))
                yield obj;
        } else {
            let list = [];
            let result = iter.call(this);
            if (result instanceof Array)
                result = util.Array.itervalues(result);

            for (let obj in result) {
                yield obj;
                list.push(obj);
            }
            // 全て列挙したときのみ
            this._cache[name] = list;
        }
    },
    clearCache: function (name) {
        delete this._cache[name];
    },
    execute: function (command, modifiers) {
        if (command === "default")
            command = this.default;
        this._commands.execute(command, modifiers);
    },
    maps: [],
    keys: [],
}, {
    getAttrValue: function (obj, attr, name) {
        while (obj) {
            if (obj.hasOwnProperty(attr)) {
                let prop = obj[attr];
                if (name in prop)
                    return prop[name] || null;
            }
            obj = obj.__proto__;
        }
        return null;
    },
    getAttrFlat: function (obj, attr) {
        let ret = {}, stack = [];
        while (obj) {
            if (obj.hasOwnProperty(attr))
                stack.push(obj[attr]);
            obj = obj.__proto__;
        }

        return stack.reduceRight(function (a, b) {
            for (let [attr, val] in Iterator(b))
                if (val === void 0)
                    delete a[attr];
                else
                    a[attr] = val;
            return a;
        }, {});
    }
}); //}}}

// XXX: add normal javascript command
PiyoSource.prototype.commands = PiyoCommands();
PiyoSource.prototype.commands._addCommand(commands.get("js"));

let PiyoItem = Class("PiyoItem", //{{{
{
    init: function init(item, view, context) {
        this.item = item;
        this.view = view;
        this.source = context;
        this.__defineGetter__("_mark", function () this.view.querySelector(".mark"));
    },
    select: function () {
        this.view.setAttribute("selected", true);
    },
    unselect: function () {
        this.view.removeAttribute("selected");
    },
    get mark() let(q = this._mark) q && q.textContent,
    set mark(value) let (q = this._mark) q && (q.textContent = value ? "*" : ""),
    toggleMark: function () this.mark = !this.mark,
});//}}}

let PiyoCache = Class("PiyoCache", //{{{
{
    init: function () {
        this.cache = {};
    },
    get: function (name, func) {
        var obj = this._get(name);
        return obj === void 0 ? obj : this._set(name, func());
    },
    iter: function (name, iterFunc) {
        var obj = this._get(name);
        if (obj === void 0) {
            let list = [];
            let res = iterFunc();
            if (res instanceof Array)
                res = util.Array.itervalues(res);
            for (let val in res) {
                list.push(val);
                yield val;
            }
            this._set(name, list);
        } else {
            for (let [, val] in Iterator(obj))
                yield val;
        }
    },
    _get: function (name) this.cache[name],
    _set: function (name, value) this.cache[name] = value,
    clear: function (name) { delete this.cache[name]; },
    clearAll: function () { this.cache = {};}
});//}}}

let PiyoCacheTime = Class("PiyoCacheTime", PiyoCache, //{{{
{
    init: function (time) {
        this.cache = {};
        this.time = time || 0;
    },
    _get: function (name) {
        if (name in this.cache) {
            let obj = this.cache[name];
            if (Date.now() < obj.time)
                return obj.data;
        }
        return void 0;
    },
    _set: function (name, value) {
        this.cache[name] = {
            time: Date.now() + this.time,
            data: value
        };
        return value;
    }
}); //}}}

let onUnload = (function () // {{{
{
    // defined function {{{
    function proxyClass(obj, proxy) {
        let original = proxy.__proto__ = obj.__proto__;
        obj.__proto__ = proxy;
        return function () {
            obj.__proto__ = original;
        };
    }
    function domAddEventListener(dom, eventName, func, useCaputre) {
        dom.addEventListener(eventName, func, useCaputre);
        return function () dom.removeEventListener(eventName, func, useCaputre);
    }
    // }}}

    //{{{ hacked liberator module
        let dispose = [];
        dispose.__defineSetter__("$push", function (v) this.push(v));

        let _box = document.createElementNS(XUL, "vbox");
        _box.id = "liberator-piyo";
        _box.collapsed = true;

        _box.classList.add("liberator-container");
        _box.classList.add("animate");

        if (!disabledFixed) {
            _box.classList.add("overlay");
        }

        dispose.$push = function () let (p = _box.parentNode) p && p.removeChild(_box);

        let bottom = document.getElementById("liberator-multiline-output").parentNode;
        let p = bottom.parentNode;
        p.insertBefore(_box, bottom);

        let iframe = document.createElementNS(XUL, "iframe");
        iframe.id = _box.id + "-iframe";
        iframe.flex = 1;

        self.iframe = iframe;

        _box.appendChild(iframe);

        let style = document.createElementNS(XHTML, "style");
        style.innerHTML = <![CDATA[
            #liberator-piyo {
                height: 100%;
                max-height: 10px;
                min-height: 10px;
                border-top: 1px solid rgba(128,128,128,.5);
                border-bottom: 1px solid rgba(128,128,128,.5);
                -moz-box-sizing: content-box;/*border-box;*/
            }
            #liberator-piyo.animate {
                -moz-transition: all .2s;
            }
            #liberator-piyo.overlay {
                position: fixed;
                left: 0;
                width: 100%;
            }
            #liberator-piyo-iframe {
                height: 100%;
                width: 100%;
                color: black;
            }
            #liberator-piyo.animate[collapsed='true'] {
                max-height: 0px !important;
                opacity: 0;
                background-color: black;
                pointer-events: none;
            }
            #liberator-piyo-iframe.deactive {
                opacity: .8;
                background-color: black;
            }
        ]]>;

        iframe.appendChild(style);

        let onceIframe = domAddEventListener(iframe, "load", function () {
            iframe.contentDocument.documentElement.id = "piyohtml"
            iframe.contentDocument.body.id = "liberator-piyo-content";
            ui.initUI();
            onceIframe();
        }, true);
        let bufferURI = "chrome://liberator/content/buffer.xhtml";
        iframe.setAttribute("src", bufferURI);

        dispose.$push = proxyClass(modules.events, {
            onFocusChange: function (event) {
                if ([modes.PIYO, modes.PIYO_I].indexOf(liberator.mode) >= 0) {
                    return;
                }
                this.__proto__.__proto__.onFocusChange.apply(this, arguments);
            },
            //onKeyPress: function (event) {
            //    if (liberator.mode === modes.PIYO) {
            //        if (ui.onEvent(event)) {
            //            event.preventDefault();
            //            event.stopPropagation();
            //            return;
            //        }
            //    }
            //    this.__proto__.__proto__.onKeyPress.apply(this, arguments);
            //}
        });

        if (fx3) {
            template.filter = function (str) <span highlight="Filter">{str}</span>;
            modules.commandline.show = function () {
                this._commandlineWidget.collapsed = false;
                this._commandWidget.focus();
            };
        }
        dispose.$push = proxyClass(modules.commandline, {
            onEvent: function (event) {
                if ([modes.PIYO, modes.PIYO_I].indexOf(liberator.mode) >= 0) {
                    if (liberator.mode === modes.PIYO) {
                        if (event.type === "focus" && liberator.mode === modes.PIYO
                            && ui.editor.compareDocumentPosition(liberator.focus) & Node.DOCUMENT_POSITION_CONTAINED_BY)
                            modes.set(modes.PIYO_I, modes.NONE, true);
                        event.preventDefault();
                        event.stopPropagation();
                    } else {
                        log("df", ui._deferred);
                        if (ui._deferred) {
                          ui.dfRefresFilter();
                        }
                        else
                            ui._updateTimer.tell();
                    }
                } else {
                    this.__proto__.__proto__.onEvent.apply(this, arguments);
                }
            },
        });

        function modeChange ([oldMode], [newMode]) {
            if (newMode === modes.COMMAND_LINE) {
                ui.iframe.classList.add("deactive");
            } else if (newMode === modes.PIYO) {
                ui.iframe.classList.remove("deactive");
            }
            // xxx: tabs._onTabSelect 対策
            else if (newMode === modes.NORMAL && oldMode === modes.PIYO) {
                liberator.threadYield(true);
                if (!ui.box.collapsed)
                    for (let s = arguments.callee.caller; s; s = s.caller) {
                        if (s === tabs._onTabSelect) {
                            log("keep piyo");
                            modes.set(modes.PIYO);
                            if (fx3) {
                                ui.box.collapsed = true;
                                ui.setTimeout(function () ui.box.collapsed = false, 0);
                            }
                            break;
                        }
                    }
            }
        }
        liberator.registerObserver("modeChange", modeChange);
        dispose.$push = function () liberator.unregisterObserver("modeChange", modeChange);
    //}}}

    // {{{ mapping
    // xxx: mode の 削除が困難なため、上書き想定で処理
    if (!modes.hasOwnProperty("PIYO")) {
        modes.addMode("PIYO", {char: "p"});
        modes.addMode("PIYO_I", {char: "pi", input: true, display: -1});
    }
    modes.getMode(modes.PIYO).display =
        function() <>PIYO #{ui.editor.value}# {ui.rowStateE4X}</>;

    modes.reset = function _reset(silent) {
        this._modeStack = [];
        if (this._prevMode) {
            this.set(this._prevMode, modes.NONE, silent);
            this._prevMode = null;
        } else if (config.isComposeWindow)
            this.set(modes.COMPOSE, modes.NONE, silent);
        else
            this.set(modes.NORMAL, modes.NONE, silent);
    };

    [ //mapping PIYO
        [["j", "<Down>", "<Tab>"], "down", function (count) ui.scroll(Math.max(count,  1), true), {count: true}],
        [["k", "<Up>", "<s-Tab>"], "up",   function (count) ui.scroll(-Math.max(count, 1), true), {count: true}],
        [["<C-f>", "<PageDown>"], "page scroll down", function (count) ui.scrollByPages( Math.max(count, 1)), {count: true}],
        [["<C-b>", "<PageUp>"], "page scroll up",   function (count) ui.scrollByPages(-Math.max(count, 1)), {count: true}],
        [["<C-c>"], "stop search", function () {
            if (ui._deferred) ui._deferred.cancel();
            else ui.build && (ui.abort = true);
        }],
        [["<Esc>"], "", function () {
            if (ui._deferred) ui._deferred.cancel();
            ui.quit();
        }],
        [["i", "a"], "piyo insert mode", function () {
            modes.set(modes.PIYO_I, modes.NONE, true);
            commandline.show();
            ui.updateStatus();
        }],
        [["<Space>"], "mark mark", function () {
            ui.selectedItem.toggleMark();
            ui.scroll(1, true);
        }],
        [["<C-a>"], "select all", function () ui.selectAll()],
        [["<S-Space>"], "toggle mark previous", function () {
            ui.selectedItem.toggleMark();
            ui.scroll(-1, true);
        }],
        [["gg"], "", function(count) ui.scroll(nullOr(count,  1)), {count: true}],
        [["G"],  "", function(count) ui.scroll(nullOr(count, -1)), {count: true}],
        [["?"], "", function() ui.showHelp()],
        [[":"], "kill key_open_vimbar", function () {
            let filter = ui.filter;
            let commands = ui.getCommands();

            commandline.input(fx3 ? ":" : "", function (args) {
                ui.execute(args);
            }, {
                completer: function (context) {
                    let cache = context.top.getCache("piyo", Object);
                    // todo: 暫定対応
                    cache.ui = ui;
                    commands.completer(context);
                },
                onCancel: function () {
                    commandline._setCommand(filter);
                    Deferred.next(function () {
                        modes.set(modes.PIYO);
                    })
                    .error(function(ex) {
                        alert(ex);
                    });
                }
            });
        }],
        [["zt"], "top",    function () util.nodeScrollIntoView(ui.selectedItem.view, 0,   -1)],
        [["zz"], "center", function () util.nodeScrollIntoView(ui.selectedItem.view, 50,  -1) || ui._resizer.tell()],
        [["zb"], "bottom", function () util.nodeScrollIntoView(ui.selectedItem.view, 100, -1)],
        [["<Return>"], "execute default action", function () {
            ui.execute("default");
        }],
        [["y"], "copy selected text", function () {
            let selection = ui.doc.defaultView.getSelection();
            util.copyToClipboard(selection, true);
        }]
    ].forEach(function (m) {
        mappings.add.apply(mappings, [[modes.PIYO]].concat(m));
    });
    [ // mapping PIYO_I
        [["<C-n>"], "down", function () ui.scroll( 1, true)],
        [["<C-p>"], "up", function () ui.scroll(-1, true)],
        //[["<C-n>"], "normal filter", function () ui.matcherType = "n"],
        //[["<C-m>"], "migemo filter", function () ui.matcherType = "m"],
        //[["<C-r>"], "regex filter", function () ui.matcherType = "r"],
        [["<Esc>", "<Return>"], "escape PIYO_I", function () {
            modes.set(modes.PIYO)
            commandline.hide();
        }],
        [["<C-Return>"], "execute", function () { ui.execute(); }],
    ].forEach(function (m) {
        mappings.add.apply(mappings, [[modes.PIYO_I]].concat(m));
    });
    // modes.INSERT から map の コピー
    // xxx: 意図してMap.modes に 登録してない
    let (maps = mappings._main[modes.PIYO_I])
        ["w", "u", "k", "a", "e", "h"].forEach(function (name) {
            maps.push(mappings.get(modes.INSERT, "<C-" + name + ">"));
        });
    // }}}


    let (name = "piyoNoScrollbar") {
        styles.addSheet(true, name, bufferURI, "html|html > xul|scrollbar { visibility: collapse !important; }", true);
        dispose.$push = function ()  styles.removeSheet(true, name);
    }

    delete dispose.$push;
    return function () {
        //delete this.onUnload;
        this.onUnload = null;
        dispose.forEach(function (f) f());

        [modes.PIYO, modes.PIYO_I].forEach(function (m) {
            mappings._main[m] = [];
            mappings.removeAll(m);
        });
    };
})(this); //}}}

var ui = PiyoUI(iframe, commandline._commandWidget);
let util = // {{{
{
    __proto__: modules.util,
    //setTarget(aNode) しないと使えない
    //getContextMenu: function (win) Object.create((win || window).nsContextMenu.prototype),
    getContextMenu: function (win) ({__proto__: (win || window).nsContextMenu.prototype}),
    nodeScrollIntoView: function nodeScrollIntoView(aNode, aVPercent, aHPercent) {
        if (!(aVPercent >= 0)) aVPercent = -1;
        if (!(aHPercent >= 0)) aHPercent = -1;
        var doc = aNode.ownerDocument;
        var win = doc.defaultView;
        if (!win) return;
        var selection = win.getSelection();

        selection.removeAllRanges();
        var r = doc.createRange();

        r.selectNode(aNode);
        selection.addRange(r);
        selection.QueryInterface(Ci.nsISelection2)
            .scrollIntoView(Ci.nsISelectionController.SELECTION_ANCHOR_REGION,
                    true, aVPercent, aHPercent);

        selection.removeAllRanges();
    },
    icon16: function (image) <img style="margin: 1px;max-height: 16px;" src={image}/>,
    normalMatcher: function (word) {
        return function (text) {
            let index = text.indexOf(word);
            return index >= 0 ? [{pos: index, len: word.length}] : [];
        };
    },
    regexpMatcher: function (word) {
        var re = new RegExp(word, "gi");
        return function (text) {
            re.lastIndex = 0;
            let list = [], m;
            while (m = re.exec(text)) {
                list.push({pos: m.index, len: m[0].length});
                if (m[0].length === 0) break;
            }
            return list;
        };
    },
    regexpMatcher2: function (word) {
        let isNot = word[0] === "-";
        if (isNot) {
            word = word.substr(1);
            if (word) {
                let re = new RegExp(word, "i");
                var f = function (text) re.test(text);
            } else
                f = function () false;

            f.exclude = true;
            return f;
        } else {
            return util.regexpMatcher(word);
        }
    },
    migemoMatcher: function (word) {
        var re = migemo.getRegExp(word, "gi");
        return function (text) {
            re.lastIndex = 0;
            let list = [], m;
            while (m = re.exec(text))
                list.push({pos: m.index, len: m[0].length});
            return list;
        };
    },
    createView: function (array, scope) {
        if (array.length === 0) return <></>;
        if (array[0] === "icon") {
        }
        array = array.map(function (a) {
            if (typeof(a) === "string") return "<td>{" + a + "}</td>";
            else {
                let text = a.text;
                delete a.text;
                let attrs = [];
                for (let attr in a) attrs.push(attr + '=\"' + a[attr].replace('"', '\\"', "g") + '"');
                return "<td " + attrs.join(" ") + ">{" + text + "}</td>";
            }
        });
        return liberator.eval(<![CDATA[(function () function (item, hi) xml)()]]>
            .toString().replace("xml", "<tr>" + array.join("") + "</tr>"), scope);
    },
    sqlquery: function sqlquery(db, query, params) {
        const fields = {
            "INTEGER": "getInt64",
            "TEXT": "getUTF8String",
        };
        try {
            var stmt = db.createStatement(query);
            var reader = [];

            if (stmt.executeStep()) {
                for (let i = 0, j = stmt.columnCount; i < j; ++i) {
                    let name = stmt.getColumnName(i);
                    let type = stmt.getColumnDecltype(i);
                    reader.push([name, fields[type]]);
                }
                do {
                    yield reader.reduce(function (obj, [n, t], i) {obj[n] = stmt[t](i); return obj;}, {});
                } while (stmt.executeStep());
            }
        } catch (ex) {
            Cu.reportError(ex);
        } finally {
            if (stmt)
                stmt.reset();
        }
    },
    lazyProto: function (base, parent) {
        let proto = new Object();

        if (parent)
            proto.__proto__ = parent;

        if (fx3)
        for (let name in base) {
            let getter = base.__lookupGetter__(name);
            if (getter) {
                proto.__defineGetter__(name, getter);
            } else
                proto[name] = base[name];
        } else
        Object.getOwnPropertyNames(base).forEach(function (name) {
            let getter = base.__lookupGetter__(name);
            if (getter) {
                proto.__defineGetter__(name, function () {
                    let value = getter.call(this);
                    Object.defineProperty(this, name, {
                        value: value,
                        writable: false,
                    });
                    return value;
                });
            } else
                proto[name] = base[name];
        });
        function constructor(item) {
            let obj = {__proto__: constructor.prototype, item: item};
            return obj;
        }
        constructor.prototype = proto;
        return constructor;
    },
    runnable: function (func, callback) {
        let generator = func(callback ? callback(generator) :function _callback(value) {generator.send(value);});
        generator.next();
    },
    http: {
        xhr: function (params) {
            try {
                let thread = services.get("threadManager").mainThread;
                let xhr = new XMLHttpRequest();
                let wait = true;
                xhr.mozBackgroundRequest = true;

                xhr.onreadystatechange = function () {
                    if (xhr.readyState == 4) {
                        wait = false;
                    }
                };
                url = params.url;
                if (params.query) {
                    let query = params.query;
                    url += "?" + util.names(query)
                        .map(function (n) [n, query[n]].map(function (v) encodeURIComponent(n)).join("="))
                        .join("&");
                }

                params.headers && params.headers.forEach(function ([name, value]) {
                    xhr.setHeader(name, value);
                });

                let t = Date.now();
                xhr.open(params.type, url, true, params.user || null, params.password || null);
                xhr.send(params.post || null);

                // todo: true or false
                while (wait && Date.now() < (t + 30 * 1000))
                    thread.processNextEvent(true);

                log(Date.now() - t, params.type, url);

                return xhr;
            } catch (ex) {
                Cu.reportError(ex);
                return null
            }
        },
        get: function (url, query) {
            return this.xhr({
                type: "GET",
                url: url,
                query: query
            });
        },
        post: function (url, query, postdata) {
            liberator.assert(null, "post is not implementation")
            if (!postdata)
                postdata = query;
            return this.xhr({
                type: "POST",
                url: url,
                query: query,
                post: postdata
            });
        }
    }
}; //}}}

/// fx3
if (fx3) {
lazyGetter(util, "names", function () function (obj) [a for(a in obj)]);
lazyGetter(util, "desc", function () function (obj) function(obj, name) {
    let result = {
        getter: obj.__lookupGetter__(name),
        setter: obj.__lookupSetter__(name)
    };
    result.value = (!result.setter && !result.getter) ? obj[name] : null;
    return result;
});
} else {
lazyGetter(util, "names", function () Object.getOwnPropertyNames.bind(Object));
lazyGetter(util, "desc", function () Object.getOwnPropertyDescriptor.bind(Object));
}

commands.addUserCommand(["pi[yo]"], "piyo command", function (args) {
    if (args["-force"]) {
        ui.forceReset();
        return;
    }

    ui.openAsync(Array.join(args, " "), args["-input"] || "");
}, {
    options: [
        [["-input", "-i"], commands.OPTION_STRING],
        [["-force", "-f"], commands.OPTION_NOARG],
        //[["-k", "-keep"],  commands.OPTION_NOARG],
    ],
    completer: function (context, args) {
        context.completions = [ [name, s.prototype.description || s.prototype.title || ""]
            for ([name, s] in Iterator(ui._sources)) if (!s.abstract)];
    },
}, true);

commands.addUserCommand(["loadpiyo"], "piyo load plugin", function (args) {
    if (args.length == 0) ui.loadPiyos();
    else ui.loadPiyo(args[0]);
}, {
    literal: 0,
    completer: function (context) completion.file(context, true)
}, true);

ui.iter = {
    tabs: function () (t for ([,t] in iter(gBrowser.mTabs))),
    vtabs: function () (t for ([,t] in Iterator(gBrowser.visibleTabs))),
    wins: function (type) iter(services.get("windowMediator").getEnumerator(type)),
};

ui.loadPiyos();
