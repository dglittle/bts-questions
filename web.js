
function defaultEnv(key, val) {
    if (!process.env[key])
        process.env[key] = val
}
defaultEnv("PORT", 5000)
defaultEnv("HOST", "http://localhost:" + process.env.PORT)
defaultEnv("NODE_ENV", "production")
defaultEnv("MONGOHQ_URL", "mongodb://localhost:27017/bts")
defaultEnv("SESSION_SECRET", "super_secret")

///

process.on('uncaughtException', function (err) {
    try {
		console.log(err)
        console.log(err.stack)
	} catch (e) {}
})

///

var _ = require('gl519')
_.run(function () {

    var db = require('mongojs').connect(process.env.MONGOHQ_URL)

    var express = require('express')
    var app = express()
    
    _.serveOnExpress(express, app)

    app.use(express.cookieParser())
    app.use(function (req, res, next) {
        _.run(function () {
            req.body = _.consume(req)
            next()
        })
    })

    var MongoStore = require('connect-mongo')(express)
    app.use(express.session({
        secret : process.env.SESSION_SECRET,
        cookie : { maxAge : 10 * 365 * 24 * 60 * 60 * 1000 },
        store : new MongoStore({
            url : process.env.MONGOHQ_URL,
            auto_reconnect : true,
            clear_interval : 3600
        })
    }))

    app.use(function (req, res, next) {
        _.run(function () {
            if (!req.session.user) {
                req.user = newObj('user', {
                    score : 0,
                    scoreDen : 0
                })
                req.session.user = req.user._id
            } else {
                req.user = getObj(req.session.user, 'user')
            }
            next()
        })
    })

    var g_rpc_version = 1

    app.get('/', function (req, res) {
        res.cookie('rpc_version', g_rpc_version, { httpOnly: false})
        res.cookie('rpc_token', _.randomString(10), { httpOnly: false})
        res.sendfile('./index.html')
    })

    app.get('/slider.js', function (req, res) {
        res.sendfile('./slider.js')
    })

    var rpc = {}
    app.all(/\/rpc\/([^\/]+)\/([^\/]+)/, function (req, res, next) {
        _.run(function () {
            try {
                if (g_rpc_version != req.params[0])
                    throw new Error('version mismatch')
                if (!req.cookies.rpc_token || req.cookies.rpc_token != req.params[1])
                    throw new Error('token mismatch')
                var input = _.unJson(req.method.match(/post/i) ? req.body : _.unescapeUrl(req.url.match(/\?(.*)/)[1]))
                function runFunc(input) {
                    return rpc[input.func].apply(null, [input.arg, req, res])
                }
                if (input instanceof Array)
                    var output = _.map(input, runFunc)
                else
                    var output = runFunc(input)
                var body = _.json(output) || "null"
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body)
                })
                res.end(body)
            } catch (e) {
                next(e)
            }
        })
    })

    ///

    function error(msg) {
        throw new Error(msg)
    }

    function getUniqueKey() {
        return _.randomString(10)
    }

    function newObj(kind, props) {
        var o = {
            _id : getUniqueKey(),
            time : _.time()
        }
        if (props)
            _.merge(o, props)
        _.p(db.collection(kind + 's').insert(o, _.p()))
        return o
    }

    function getObj(key, kind) {
        if (!key) return
        var o = _.p(db.collection(kind + 's').findOne({ _id : key }, _.p()))
        if (!o)
            error('object not found: ' + key)
        return o
    }

    function cap(t, t0, t1) {
        if (t < t0)
            return t0
        if (t > t1)
            return t1
        return t
    }

    function lerpCap(t0, v0, t1, v1, t) {
        var t = cap(t, t0, t1)
        return (t - t0) * (v1 - v0) / (t1 - t0) + v0
    }

    function enrichQuestion(q) {
        function safe(x) { return x || 0 }
        q.averageAnswer = safe(q.answerCounts.yes) / (safe(q.answerCounts.yes) + safe(q.answerCounts.no))
        q.averageGuess = safe(q.guessNum) / safe(q.guessDen)
        return q
    }

    function answerQuestion(u, q, answer, guess) {
        var inc = {}
        inc['answerCounts.' + answer] = 1
        var goodAnswer = answer.match(/yes|no/)
        if (goodAnswer) {
            inc.guessNum = guess
            inc.guessDen = 1
        }

        q = _.p(db.collection('questions').findAndModify({
            query : {
                _id : q,
                answeredBy : { $nin : [u._id] }
            },
            update : {
                $inc : inc,
                $push : { answeredBy : u._id }
            },
            new : true
        }, _.p()))

        if (!q) error('you already answered this!')
        q = enrichQuestion(q)

        var a = newObj('answer', {
            user : u._id,
            answer : answer,
            guess : guess
        })

        if (goodAnswer) {
            u = _.p(db.collection('users').findAndModify({
                query : {
                    _id : u._id
                },
                update : {
                    $inc : {
                        score : lerpCap(0, 100, 0.5, 0, Math.abs(guess - q.averageAnswer)),
                        scoreDen : 100
                    }
                },
                new : true
            }, _.p()))
        }
        
        return [u, q, a]
    }

    function getQuestions(u, n) {

        function pickOne() {
            db.collection('questions').ensureIndex({ random : 1 }, { background : true })
            return _.p(db.collection('questions').find({
                random : { $gt : Math.random() },
                answeredBy : { $ne : u._id }
            }).sort({ random : 1 }).limit(1, _.p()))[0]
        }

        var qs = {}
        for (var t = 0; t < 20; t++) {
            var q = pickOne()
            if (!q) continue
            if (!qs[q._id])
                qs[q._id] = q
            if (_.values(qs).length >= n) break
        }

        return _.map(_.values(qs), function (e) { return { _id : e._id, text : e.text } })
    }

    rpc.getQuestions = function (q, req, res) {
        var u = req.user
        return {
            questions : getQuestions(u, 3),
            user : u
        }
    }

    rpc.answerQuestion = function (q, req, res) {
        var u = req.user
        var uqa = answerQuestion(u, q.question, q.answer, 1 * q.guess)
        return {
            question : enrichQuestion(_.merge(_.omit(uqa[1], 'answeredBy'), { userAnswer : uqa[2] })),
            newQuestions : getQuestions(u, 3),
            user : uqa[0]
        }
    }

    ///

    app.use(express.errorHandler({
        dumpExceptions: true,
        showStack: true
    }))

    app.listen(process.env.PORT, function() {
        console.log("go to " + process.env.HOST)
    })

})
