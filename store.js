'use strict';

const _ = require('lodash');
const bodyParser = require('body-parser');
const express = require('express');
const fs = require('fs');
const mongodb = require('mongodb');
const path = require('path');
const sendPostRequest = require('request').post;
const colors = require('colors/safe');

const app = express();
const MongoClient = mongodb.MongoClient;
const port = 4000;
const mongoCreds = require('./auth.json');
const mongoURL = `mongodb://${mongoCreds.username}:${mongoCreds.password}@${mongoCreds.endpoint}/${mongoCreds.default_database}`;
const handlers = {};


function makeMessage(text) {
  return `${colors.blue('[store]')} ${text}`;
}

function log(text) {
  console.log(makeMessage(text));
}

function error(text) {
  console.error(makeMessage(text));
}

function failure(response, text) {
  const message = makeMessage(text);
  console.error(message);
  return response.status(500).send(message);
}

function success(response, text) {
  const message = makeMessage(text);
  console.log(message);
  return response.send(message);
}

function mongoConnectWithRetry(delayInMilliseconds, callback) {
  MongoClient.connect(mongoURL, (err, connection) => {
    if (err) {
      console.error(`Error connecting to MongoDB: ${err}`);
      setTimeout(() => mongoConnectWithRetry(delayInMilliseconds, callback), delayInMilliseconds);
    } else {
      log('connected succesfully to mongodb');
      callback(connection);
    }
  });
}

// Keep track of which games have used each stim
function recordStimUse(stimdb, gameid, idList) {
  _.forEach(idList, id => {
    stimdb.update({_id: id}, {
      $push : {games : gameid},
      $inc  : {numGames : 1}
    }, {multi: true}, function(err, items) {
      // do something when done?
    });
  });
}

function serve() {

  mongoConnectWithRetry(2000, (connection) => {

    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));

    app.post('/db/exists', (request, response) => {            

      if (!request.body) {
        return failure(response, '/db/exists needs post request body');
      }
      const databaseName = "reference_game";
      const database = connection.db(databaseName);
      const query = request.body.query;
      const projection = request.body.projection;

      // Get all collections within the requested database
      var collectionList = ["emotion_reference_game"];

      function checkCollectionForHits(collectionName, query, projection, callback) {
        const collection = database.collection(collectionName);        
        collection.find(query, projection).limit(1).toArray((err, items) => {          
          callback(!_.isEmpty(items));
        });  
      }

      function checkEach(collectionList, checkCollectionForHits, query,
			 projection, evaluateTally) {
        var doneCounter = 0;
        var results = 0;          
        collectionList.forEach(function (collectionName) {
          checkCollectionForHits(collectionName, query, projection, function (res) {
            log(`got request to find_one in ${collectionName} with` +
                ` query ${JSON.stringify(query)} and projection ${JSON.stringify(projection)}`);          
            doneCounter += 1;
            results+=res;
            if (doneCounter === collectionList.length) {
              evaluateTally(results);
            }
          });
        });
      }
      function evaluateTally(hits) {
        console.log("hits: ", hits);
        response.json(hits>0);
      }

      checkEach(collectionList, checkCollectionForHits, query, projection, evaluateTally);

    });

    app.post('/db/insert', (request, response) => {
      if (!request.body) {
        return failure(response, '/db/insert needs post request body');
      }
      log(`got request to insert into ${request.body.colname}`);
      
      const databaseName = "reference_game";
      const collectionName = "emotion_reference_game";
      if (!collectionName) {
        return failure(response, '/db/insert needs collection');
      }
      if (!databaseName) {
        return failure(response, '/db/insert needs database');
      }

      const database = connection.db(databaseName);
      
      // Add collection if it doesn't already exist
      if (!database.collection(collectionName)) {
        console.log('creating collection ' + collectionName);
        database.createCollection(collectionName);
      }

      const collection = database.collection(collectionName);

      const data = _.omit(request.body, ['colname', 'dbname']);
      // log(`inserting data: ${JSON.stringify(data)}`);
      collection.insert(data, (err, result) => {
        if (err) {
          return failure(response, `error inserting data: ${err}`);
        } else {
          return success(response, `successfully inserted data. result: ${JSON.stringify(result)}`);
        }
      });
    });

    app.post('/db/getstims', (request, response) => {
      if (!request.body) {
        return failure(response, '/db/getstims needs post request body');
      }
      log(`got request to get stims from ${request.body.dbname}/${request.body.colname}`);
      
      const databaseName = request.body.dbname;
      const collectionName = request.body.colname;
      if (!collectionName) {
        return failure(response, '/db/getstims needs collection');
      }
      if (!databaseName) {
        return failure(response, '/db/getstims needs database');
      }

      const database = connection.db(databaseName);
      const collection = database.collection(collectionName);

      collection.aggregate([
    	{ $group : {_id : "$numGames", count: { $sum: 1 }}}
          ], (err, results) => {console.log('counts...'); console.log(results)});
          
          // get a random sample of stims that haven't appeared more than k times
          collection.aggregate([
    	{ $addFields : { numGames: { $size: '$games'} } }, 
    	// { $group : { _id : "$family", numGames: {$avg : "$numGames"},
    	// 	     family: { $push: "$$ROOT" } } },
    	{ $sort : { numGames : 1} },	
    	{ $limit : request.body.numRounds }
          ], (err, results) => {
    	if(err) {
    	  console.log(err);
    	} else {
    	  
    	  recordStimUse(collection, request.body.gameid, _.map(results, '_id'));
    	  response.send(results);
    	}
      });
    });

    app.listen(port, () => {
      log(`running at http://localhost:${port}`);
    });
    
  });
  
}

serve();
