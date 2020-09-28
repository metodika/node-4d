# Node-4D module

### Introduction

The node-4d module is a driver that allows you to communicate with 4D's SQL server. It is a NodeJS module written in JavaScript and does not require compiling. It's API is moddelled after the MySQLJS API. It can work with 4D (local mode) and 4D Server, but the SQL server must be running.

The module contains of a single file called "node-4d.js". This file must be placed inside your project directory. It can then be loaded using the `require` function.

Here is a short example, that shows how to use the library:

```javascript
var fourd = require( "node-4d.js" );
var settings = { host: 'localhost', port: 19812, user: 'John Doe', password: 'john' };
var connection = fourd.createConnection( settings );

connection.connect( function( error ) {
  if( error ) {
    console.log( "Cannot connect to database: " + error );
    return;
  } else {
    var sql = "SELECT * FROM company WHERE id = ?";
    connection.query( sql, 1101, function( error, result, fields ) {
      if( error ) {
        console.log( "Failed to run query: " + error );
        return;
      } else {
        console.log( "Row count: " + result.rowCount );
        console.log( "Column count: " + result.columnCount );
        console.log( "Row data: " + result.rows );
        results.rows.forEach( function( row ) {
          console.log( row.id, row.name );
        } );
      }
    } );
  }
} );
```

### License

Copyright 2017 Rob Laveaux <rob.laveaux@pluggers.nl>
This file is part of the node-4d Library.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### API Reference

#### DbFactory

The functions in the DbFacatory class are the ones that are exported by the node-4d module. The functions can be used to create new connection objects and connection pools. A connection object represents a single connection, a connection pool is a dynamic array of re-usable connections.

##### DbFactory.createConnection( options )

Returns a DbConnection object, that is initialised with the given options. The connection is not yet opened.

The options parameter is an object that defines the settings to use for the connection. The following properties are used:

| Property | Description                              |
| -------- | ---------------------------------------- |
| host     | The IP address or host name to connect to (default value is "127.0.0.1"). |
| port     | The port number to connect to (default value is 19812). |
| user     | The username to use for the login (default value is "Administrator"). |
| password | The password to use for the login.       |

See the documentation for the DbConnection class for more details.

##### DbFactory.createPool( options )

Returns a DbConnectionPool object. It holds an array of persistent re-usable connections.

The options parameter is an object that defines the settings to use for creating the connections. The properties are described at the createConnection function.

#### DbConnection

A DbConnection represents a connection to the database. It offers functionality to open connections, send queries to the database and to close connections.

##### DbConnection.connect( callback )

Opens a connection to the database. Upon completion the callback function is invoked. The callback function receives a single parameter, an error object. If the connection failed, then the parameter is an object with information regarding the error. If the connection was successfull, then the error parameter is set to null.

##### DbConnection.end()

Ends the connection to the database. A logout and quit command are send to the server after which the server will close the connection with the client.

##### DbConnection.release()

This function is only available for connections that are part of a connection pool. Calling this function makes the connection available again, so that it can be re-used.

##### DbConnection.query( sql, params, callback )

Sends a sql query to the database. The first parameter is a string holding the SQL statement. It may contain place holders for variables. Place holders can be defined in two ways:

- By index ($0, $1, $2 etc.)
- By name (a string starting with the $ character, i.e. $id)

The values for these placeholders are passed in the second parameter. The values can be passed in the following ways:

- As multiple arguments (placeholders accessed by index)
- As an array of arguments (placeholders accessed by index)
- As an object of arguments  (placeholders accessed by name)

If the params parameter is an object, then the placeholders in the SQL statement should match the keys inside the object.

The last parameter is the callback function which will be executed when the query is completed, or in case of an error. The callback function receives 3 parameters: errors, results and fields. In case of error, the error parameter is set. If the query ran without errors, then the errors parameter is set to null. The results parameter is an object with information regarding the returned results. It holds the following properties:

| Property    | Description                              |
| ----------- | ---------------------------------------- |
| rowCount    | The number of returned rows.             |
| columnCount | The number of returned columns.          |
| rows        | An array of objects, holding the row data. |

#### DbConnectionPool

A DbConnection represents a pool of reusable, persistent database connections. It offers functionality to obtain a connection from the pool and release it.

##### DbConnectionPool.getConnection( callback )

Obtains an available connection from the pool. When a connection is obtained, the callback function is executed. When no connections are available, then a new connection is created and added to the pool.

##### DbConnectionPool.release( connection )

When a connection obtained from the pool is no longer needed, then it needs to be returned to the pool when it is no longer needed. This makes the connection reusable.

Releasing a connection can be done in two ways:

- By calling the `release()` function on the connection object.
- By calling the `release( connection )` object on the pool object.

##### DbConnectionPool.end()

Ends all connections in the pool. This function should be called when the pool is no longer needed. 

The function iterates over all the connections in the pool and calls the `end()` function on each connection. This sends a logout and quit command to the server.

##### DbConnectionPool.query( sql, params, callback )

Obtains a connection from the pool and runs the SQL query. When the query is done, the connection is automatically released to the pool.