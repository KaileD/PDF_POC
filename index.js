const express = require('express');
const app = express();
const path = require('path');
const PORT = 8080;

const http = require('http').Server(app);
const io = require('socket.io')(http);
const bodyParser = require('body-parser');
const auth = require('http-auth');
const request = require('request');

var basic = auth.basic({
    realm: 'SUPER SECRET STUFF'
}, function(username, password, callback) {
    callback(username == 'MYTESTAPIKEY'); // Insert your own authentication methods
});

var basicfront = auth.basic({
    realm: 'SUPER SECRET STUFF FRONT END'
}, function(username, password, callback) {
    callback(username == 'Admin' && password == 'scaleapi'); // Insert your own authentication methods
});

var authMiddleware = auth.connect(basic);
var authMiddlewarefront = auth.connect(basicfront);

var mongoose = require('mongoose');
var mongoDB = 'mongodb://127.0.0.1/my_database';
mongoose.connect(mongoDB, { useNewUrlParser: true });

var Task = require('./app/models/task');

app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(bodyParser.json());

app.get('/', authMiddlewarefront, function(req, res) {
    res.sendfile('public/index.html');
});

// ROUTES FOR OUR API
// =============================================================================
const router = express.Router(); // get an instance of the express Router

router.get('/:task_id', authMiddleware, function(req, res) {
    Task.findOne({
        _id: req.params.task_id
    }, function(err, task) {
            if (err) {
                res.send(err);
            } else {
                var mytask = JSON.parse(JSON.stringify(task));
                mytask.task_id = mytask._id;
                delete mytask.api_key;
                delete mytask._id;
                delete mytask.__v;
                (mytask.response.annotations).map(function(e) {delete e._id});
                res.json(mytask);
            }
    });
});

// Main entry point for image annotations
// TODO: This is not being used
router.post('/annotation', authMiddleware, function(req, res) {
    console.log('hello world2');
    // create database entry of the task
    var task = new Task();
    task.instruction = req.body.instruction;
    task.params.attachment = req.body.attachment;
    if (!req.body.attachment) {
        res.send("Must specify a URL to an image");
    }
    task.params.attachment_type = req.body.attachment_type;
    if (req.body.objects_to_annotate.length == 0) {
        res.send("Must specify objects to annotate");
    }
    task.params.objects_to_annotate = req.body.objects_to_annotate;
    task.params.with_labels = false;
    if (req.body.with_labels) {
        task.params.with_labels = req.body.with_labels;
    }
    task.callback_url = req.body.callback_url;
    if (!req.body.callback_url) {
        res.send("Must specify a URL to callback");
    }
    task.created_at = new Date();
    task.api_key = req.user;
    task.status = "pending";
    task.type = "annotation";

    task.save(function(err) {
        if (err)
            res.send(err);

        // Send the json Response back to requester
        var jsonResponse = JSON.parse(JSON.stringify(task));

        jsonResponse.task_id = jsonResponse._id;
        delete jsonResponse.api_key;
        delete jsonResponse._id;
        delete jsonResponse.__v;
        delete jsonResponse.response;
        res.json(jsonResponse);
    });
});


// WEB SOCKET COMMUNICATION
// =============================================================================

io.on('connection', function(socket) {
    Task.find({
        status: "pending"
    }, function(err, tasks) {
        if (err) {
            io.emit("message", err);
        } else {
            io.emit("task", tasks[0]);
            io.emit("tasks", tasks);
        }
    });

    // When completed a task, will try to save to Database
    // and send POST request back to callback_url
    socket.on('task', function(data) {

        // Modify task in mongodb
        Task.findOne({
            _id: data._id
        }, function(err, task) {
            if (err) {
                io.emit("message", err);
            } else {
                io.emit("message", "Task found, starting to save to database...");
                task.completed_at = new Date();
                if (task.params.with_labels) {
                    task.response = {
                        annotations: data.annotations
                    };
                } else {
                    (data.annotations).map(function(e) {delete e.label});
                    task.response = {
                        annotations: data.annotations
                    };
                }
                task.status = "completed";
                task.save(function(err) {
                    if (err) {
                        io.emit("message", err);
                    } else {

                        // Send request to callback url
                        io.emit("message", "Saved to database successfully, now sending request...");
                        var jsonResponse = {};
                        var mytask = JSON.parse(JSON.stringify(task));
                        var response = JSON.parse(JSON.stringify(task.response))
                        var mytaskid = task._id
                        mytask.task_id = jsonResponse._id;
                        delete mytask.api_key;
                        delete mytask._id;
                        delete mytask.__v;
                        (mytask.response.annotations).map(function(e) {delete e._id});
                        (response.annotations).map(function(e) {delete e._id});
                        jsonResponse.task = mytask;
                        jsonResponse.response = response;
                        jsonResponse.task_id = mytaskid;
                        var options = {
                            uri: task.callback_url,
                            method: 'POST',
                            json: jsonResponse
                        };
                        request(options, function(err, response, body) {
                            if (err) {
                                io.emit("message", "Error sending request");
                            } else {
                                Task.find({
                                    status: "pending"
                                }, function(err, tasks) {
                                    if (err) {
                                        io.emit("message", err);
                                    } else {
                                        io.emit("tasks", tasks);
                                    }
                                });
                                io.emit("message", "Successfully sent request.");
                            }
                        });
                    }
                });
            }
        });
    });

    // When the front end sends an error about the task, send it back to callback_url
    socket.on('error_msg', function(data) {
        console.log(data);
        var options = {
            uri: data.task.callback_url,
            method: 'POST',
            json: {
                'error': data.error
            }
        };
        Task.findOne({
            _id: data.task._id
        }, function(err, task) {
            if (err) {
                io.emit("message", err);
            } else {
                task.status = 'completed'
                task.save(function(err) {
                    if (err) {
                        io.emit("message", err);
                    } else {
                        request(options, function(err, response, body) {
                            if (err) {
                                io.emit("message", "Error sending request");
                            } else {
                                io.emit("message", "Error successfully sent.");
                            }
                        });
                        Task.find({
                            status: "pending"
                        }, function(err, tasks) {
                            if (err) {
                                io.emit("message", err);
                            } else {
                                io.emit("tasks", tasks);
                            }
                        });
                    }
                });
            }
        });
    });

    // Sort by Date Created
    socket.on('date_created', function() {
        Task.find({status: "pending"}).sort('created_at').exec(function(err, tasks) {
            io.emit("tasks", tasks);
        });
    });

    // Dubug purposes, should not be used
    socket.on('reset', function() {
        Task.update({
                status: 'completed'
            }, {
                status: 'pending'
            }, {
                multi: true
            },
            function(err, num) {
                console.log("updated " + num);
            }
        );
    });
});


// REGISTER OUR ROUTES -------------------------------
app.use('/api/task', router);

app.listen(PORT, () => console.log(`server started on port ${PORT}`));
