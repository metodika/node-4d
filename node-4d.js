/* --------------------------------------------------------------------------------
 #
 #	node-4d.js
 #	Project : node-4d
 #	author : roblaveaux
 #	24-01-2017
 #
 # --------------------------------------------------------------------------------*/

var os = require( 'os' );
var net = require( 'net' );
var crypto = require( 'crypto' );

const kCRLF = "\r\n";

var DbFactory = {};

DbFactory.createConnection = function( options )
{
	var db = new DbConnection( options );
	return db;
}

DbFactory.createPool = function( options )
{
	return new DbConnectionPool( options );
}

function DbConnection( options )
{
	this.port = options.port || 19812;
	this.host = options.host || '127.0.0.1';
	this.user = options.user || 'Administrator';
	this.password = options.password || '';
	this.options =  options;
	this.socket = null;
	this.connected = false;
	this.buffer = Buffer.alloc( 0 );
	this.error = 0;
	this.errorMessage = '';
	this.nextCommandID = 1;
	this.fetchLimit = 999999;
	this.queue = {};
	
	this.socket = new net.Socket();
	this.socket.setKeepAlive( true, 30 * 1000 );
	
	var self = this;
	
	this.socket.setTimeout( 180 * 1000, function () {
		console.log( 'Node-4D: Socket timeout' );
		self.connected = false;
	} );
	
	this.socket.on( 'error', function ( error ) {
		console.log( 'Node-4D: Socket error', error );
	} );
	
	this.socket.on( 'close', function ( error ) {
		console.log( 'Node-4D: Connection closed' );
	} );
	
	this.socket.on( 'data', function ( data ) {
		// Append the incoming data to the buffer
		self.buffer = Buffer.concat( [ self.buffer, data ] );

		while( packet = self.readPacket() ) {
			
			if( packet.type == 'headers' ) {
				// Take the command from the command queue
				var command = self.queue[packet.commandID];
				var [ headers, offset ] = command.parseHeaders( self.buffer );
				if( offset > 0 ) {
					self.buffer = self.buffer.slice( offset );
				}
				command.setResponseHeaders( headers );
				if( command.onDataHandler ) {
					command.onDataHandler( headers );
				}
				// Remove the command from the queue when it is completed
				if( command.completed ) {
					delete self.queue[command.commandID];
				}
			} else if( packet.type == 'data' ) {
				// Take the command from the command queue
				var command = self.queue[packet.commandID];
				var [ rows, offset ] = command.parseRows( self.buffer );
				if( offset > 0 ) {
					self.buffer = self.buffer.slice( offset );
				}
				if( offset == 0 ) {
					// The buffer contains a partial row, exit the loop and wait for more data
					break;
				}
				command.setRows( rows );
				if( command.onDataHandler ) {
					command.onDataHandler( rows );
				}
				// Remove the command from the queue when it is completed
				if( command.completed ) {
					delete self.queue[command.commandID];
				}
			}
		}
	} );
}

DbConnection.prototype.readPacket = function()
{
	var packet = null;
	
	// Read the first 32 bytes as an ascii string so we can have a peak at the data
	var string = this.buffer.toString( 'ascii', 0, 32 );
	var matches = [];
	
	// Check if we have received headers or row data
	if( matches = string.match( /^(\d+) (\w+)$/m ) ) {
		// Check if the buffer contains a complete header
		if( this.buffer.indexOf( kCRLF + kCRLF ) != -1 ) {
			packet = { type: 'headers', commandID: matches[1] };
			this.lastCommandID = packet.commandID;
		}
	} else if( string.match( /^[0|1|2]/m ) ) {
		packet = { type: 'data', commandID: this.lastCommandID };
	}

	return packet;
}

DbConnection.prototype.createCommand = function( type )
{
	var command = new DbCommand( this.nextCommandID++, type );
	return command;
}

DbConnection.prototype.sendCommand = function( command )
{
	// console.log( 'Send Command: ' + command.request );
	this.socket.write( command.request );
	this.queue[command.commandID] = command;
}

DbConnection.prototype.connect = function( callback )
{
	var self = this;
	console.log( 'Node-4D: Connecting' );
	
	this.socket.connect( this.port, this.host, function () {
		console.log( 'Node-4D: Connected' );
		var command = self.createCommand( 'LOGIN' );
		command.request += 'USER-NAME:' + self.user + kCRLF;
		command.request += 'USER-PASSWORD:' + self.password + kCRLF;
		command.request += 'REPLY-WITH-BASE64-TEXT:Y' + kCRLF;
		command.request += 'PROTOCOL-VERSION:13.0' + kCRLF;
		command.request += 'OS-NAME:' + os.platform() + kCRLF;
		command.request += 'OS-VERSION:' + os.release() + kCRLF;
		command.request += kCRLF;
		
		command.onDataHandler = function( data ) {
			this.completed = true;
			self.connected = ( data.status == 'OK' );
			if( self.connected ) {
				console.log( 'Node-4D: Login OK' );
				this.onCompleteHandler( null );
			} else {
				console.log( 'Node-4D: Login failed' );
				this.onCompleteHandler( this.errors );
			}
		}
		
		command.onCompleteHandler = callback;
		
		self.sendCommand( command );
	} );
}

DbConnection.prototype.end = function()
{
	if( !this.connected ) {
		throw new Error( 'Cannot logout. Not connected to database' );
	}
	
	this.connected = false;
	
	// Send the logout command
	var logoutCommand = this.createCommand( 'LOGOUT' );
	logoutCommand.request += kCRLF;

	logoutCommand.onDataHandler = function( data ) {
		console.log( 'Node-4D: Logout received' );
		this.completed = true;
	};
	
	this.sendCommand( logoutCommand );
	
	// Followed by a quit command (the server will close the connection for us)
	var quitCommand = this.createCommand( 'QUIT' );
	quitCommand.request += kCRLF;

	quitCommand.onDataHandler = function( data ) {
		console.log( 'Node-4D: Quit received' );
		this.completed = true;
	};

	this.sendCommand( quitCommand );
}

DbConnection.prototype.query = function( sql, params, callback )
{
	if( !this.connected ) {
		throw new Error( 'Cannot perform query. Not connected to database' );
	}

	// If params are supplied as multiple arguments, then put them in an array
	if( typeof params != 'object' ) {
		params = Array.prototype.slice.call( arguments, 1, -1 );
	}

	// Substitute the params in the SQL statement
	sql = prepareSQL( sql, params );

	var command = this.createCommand( 'EXECUTE-STATEMENT' );
	command.request += 'STATEMENT:' + sql + kCRLF;
	command.request += 'OUTPUT-MODE:Release' + kCRLF;
	command.request += 'PREFERRED-IMAGE-TYPES:jpg png' + kCRLF;
	command.request += 'FIRST-PAGE-SIZE:' + this.fetchLimit + kCRLF;
	command.request += 'FULL-ERROR-STACK:Y' + kCRLF;
	command.request += kCRLF;
	
	var self = this;

	command.onDataHandler = function( data ) {
		if( Array.isArray( data ) == false  ) {
			if( this.errors ) {
				this.completed = true;
				this.onCompleteHandler( this.errors, null, null );
			}
		} else {
			// Check if we need to fetch more rows
			if( this.result.rowCountReceived == this.result.rowCountSent && this.result.rows.length < this.result.rowCount ) {
				self.fetch( this.result, this.onCompleteHandler );
			} else if( this.result.rows.length >= this.result.rowCount ) {
				// We have fetched all rows, run the on complete handler
				this.completed = true;
				this.onCompleteHandler( this.errors, this.result, this.result.fields );
			}
		}
	}
	
	command.onCompleteHandler = callback;
	
	this.sendCommand( command );
}

DbConnection.prototype.fetch = function( result, callback )
{
	if( !this.connected ) {
		throw new Error( 'Cannot perform fetch. Not connected to database' );
	}
	
	var self = this;
	var commandIndex = 0;
	var firstRow = result.rows.length + 1;
	var lastRow = result.rows.length + this.fetchLimit;
	
	var command = this.createCommand( 'FETCH-RESULT' );
	command.request += 'STATEMENT-ID:' + result.statementID + kCRLF;
	command.request += 'COMMAND-INDEX:' + commandIndex + kCRLF;
	command.request += 'OUTPUT-MODE:Release' + kCRLF;
	command.request += 'FIRST-ROW-INDEX:' + firstRow + kCRLF;
	command.request += 'LAST-ROW-INDEX:' + lastRow + kCRLF;
	command.request += 'FULL-ERROR-STACK:Y' + kCRLF;
	command.request += kCRLF;
	
	command.onDataHandler = function( data ) {
		if( Array.isArray( data ) == false ) {
			if( this.errors ) {
				this.completed = true;
				this.onCompleteHandler( this.errors, null, null );
			}
		} else {
			this.setRows( data );
			// Check if we need to fetch more rows
			if( this.result.rowCountReceived == this.result.rowCountSent && this.result.rows.length < this.result.rowCount ) {
				self.fetch( this.result, this.onCompleteHandler );
			} else if( this.result.rows.length == this.result.rowCount ) {
				// We have fetched all rows, run the on complete handler
				this.completed = true;
				this.onCompleteHandler( this.errors, this.result, this.result.fields );
			}
		}
	}
	
	command.onCompleteHandler = callback;
	
	this.sendCommand( command );
}

function DbCommand( id, type )
{
	this.commandID = ( '0000000000' + id ).substr( -10, 10 );
	this.type = type;
	this.status = '';
	this.request = this.commandID + ' ' + this.type + kCRLF;
	this.result = null;
	this.onDataHandler = null;
	this.onCompleteHandler = null;
	this.completed = false;
}

DbCommand.prototype.parseHeaders = function( buffer )
{
	var headers = {};
	var offset = buffer.indexOf( kCRLF + kCRLF );
	var packet = buffer.toString( 'utf8', 0, offset );
	
	if( packet.match( /^\d+ \w+$/m ) && offset != 0 ) {
		// Define a list of headers that contain lists
		const listTypes = [ 'Column-Types', 'Column-Aliases', 'Column-Updateability' ];
		var lines = packet.split( '\r\n' );
		
		var pos = lines[0].indexOf( ' ' );
		headers.commandID = lines[0].substr( 0, pos ).trim();
		headers.status = lines[0].substr( pos + 1 ).trim();
		
		for( var i = 1 ; i < lines.length ; i++ ) {
			pos = lines[i].indexOf( ':' );
			if( pos == -1 )
				continue;
			var key = lines[i].substr( 0, pos ).trim();
			var value = lines[i].substr( pos + 1 ).trim();
			// If the key indicates Base64 encoding, then decode the value
			if( key.substr( -7 ) == '-Base64' ) {
				key = key.substr( 0, key.length - 7 )
				value = base64Decode( value );
			}
			
			// If the header starts with StackError, then decode the base64-encoded description
			if( key.startsWith( 'Stack-Error' ) ) {
				value = value.replace( /(\w+ \d+ \d+ )(.+)/, function( fullMatch, part1, part2 ) {
					return part1 + base64Decode( part2 );
				} );
			}

			// If the key indicates a column that is a list, then split the list into an array
			if( listTypes.indexOf( key ) != -1 ) {
				value = splitList( value );
			}
			
			// Remove the hyphen from the key
			key = key.replace( /-/g, '' );
			if( key == 'RowCount-Sent' ) {
				debugger;
			}
			headers[key] = value;
		}
		
		offset += ( 2 * kCRLF.length );
	} else {
		headers = null;
	}
	
	return [ headers, offset ];
}

DbCommand.prototype.setResponseHeaders = function( headers )
{
	var result = new DbResultSet();
	this.result = result;
	this.result.headers = headers;
	console.log( headers );
	if( headers.status == 'ERROR' ) {
		this.errors = {};
		this.errors.code = Number( headers.ErrorCode );
		this.errors.message = headers.ErrorDescription;
		if( headers.StackError1 )
			this.errors.message += '\n' + headers.StackError1;
		if( headers.StackError2 )
			this.errors.message += '\n' + headers.StackError2;
		if( headers.StackError3 )
			this.errors.message += '\n' + headers.StackError3;
		return;
	}
	
	result.resultType = headers.ResultType || 'ERROR';
	if( headers.ResultType == 'Result-Set' || headers.ResultType == 'Update-Count' ) {
		result.statementID = headers.StatementID;
		result.commandCount = Number( headers.CommandCount );
		result.columnCount = Number( headers.ColumnCount );
		result.rowCount = Number( headers.RowCount );
		result.rowCountSent = Number( headers.RowCountSent );
		result.rowCountReceived = 0;
		result.fields = [];
		result.rows = [];
		for( var i = 0 ; i < headers.ColumnTypes.length ; i++ ) {
			result.fields.push( {
				name: headers.ColumnAliases[i],
				type: headers.ColumnTypes[i],
				updatable: ( headers.ColumnUpdateability[i] == 'Y' )} 
			);
		}
	}
}

DbCommand.prototype.parseRows = function( buffer )
{
	var offset = 0;
	var result = [];
	var offsetLastRecord = 0;
	
	// Fill an array with the column names and types
	var names = this.result.headers.ColumnAliases.slice();
	var types = this.result.headers.ColumnTypes.slice();
	// If the rowset is updateable, then the first item in the data is the row number
	if( this.result.headers.ColumnUpdateability.indexOf( 'Y' ) != -1 ) {
		names.unshift( '__RECORDNR__' );
		types.unshift( 'VK_LONG' );
	}

	while( offset < buffer.length ) {
		
		var record = {};
		var columnCount = 0;
		
		try {
			for( var colNr = 0 ; colNr < types.length ; colNr++ ) {
				
				if( offset >= buffer.length) {
					break;
				}
				
				var name = names[colNr];
				var type = types[colNr];
				var length = 0;
				var value, error;
				var status = buffer.toString( 'ascii', offset, offset + 1 );
				offset++;
				
				switch( status ) {
					case '0' :
						value = null;
						break;
					case '1' :
						switch( type ) {
							case 'VK_STRING' :
							case 'VK_TEXT' :
								length = Math.abs( buffer.readInt32LE( offset ) );
								offset += 4;
								length *= 2;
								value = buffer.toString( 'utf16le', offset, offset + length );
								offset += length;
								break;
							case 'VK_LONG' :
								value = buffer.readInt32LE( offset );
								offset += 4;
								break;
							case 'VK_BYTE' :
								value = buffer.readInt8( offset );
								offset += 1;
								break;
							case 'VK_WORD' :
								value = buffer.readInt16LE( offset );
								offset += 2;
								break;
							case 'VK_LONG8' :
								// Note: JavaScript uses a 64-bit double for numbers, which does not cover the entire range of a 64-bit int
								value = ( buffer.readInt32LE( offset ) << 8 ) + buffer.readInt32LE( offset + 4 );
								offset += 8;
								break;
							case 'VK_REAL' :
								value = buffer.readDoubleLE( offset );
								offset += 8;
								break;
							case 'VK_FLOAT' :
								value = buffer.readDoubleLE( offset );
								offset += 4;
								break;
							case 'VK_BOOLEAN' :
								value = buffer.readInt16LE( offset );
								offset += 2;
								break;
							case 'VK_TIME' :
							case 'VK_TIMESTAMP' :
								var year = buffer.readInt16LE( offset );
								offset += 2;
								var month = buffer.readInt8( offset );
								offset += 1;
								var day = buffer.readInt8( offset );
								offset += 1;
								var seconds = buffer.readInt32LE( offset );
								offset += 4;
								value = new Date( year, month - 1, day, 0, 0, seconds );
								break;
							case 'VK_DURATION' :
								value = buffer.readInt32LE( offset );
								offset += 4;
								break;
							case 'VK_BLOB' :
							case 'VK_IMAGE' :
								length = buffer.readInt32LE( offset );
								offset += 4;
								value = buffer.slice( offset, offset + length );
								offset += length;
								break;
							default :
								error = "Unknown data-type: " + type;
								throw error;
						}
						break;
					case '2' :
						error = "Error in data from stream: " + buffer.readInt32LE( offset );
						offset += 4;
						throw error;
					default :
						error = "Unknown status byte: " + status;
						throw error;
				}
				
				record[name] = value;
				columnCount++;
			}
			
			// If we have all the expected columns, then add the record to the result
			if( columnCount == types.length ) {
				result.push( record );
				offsetLastRecord = offset;
			}
		} catch( error ) {
			if( error instanceof RangeError ) {
				// We have exceeded the bounds of the buffer (an incomplete row), exit the loop
				break;
			} else {
				throw error;
			}
		}
	}
	
	return [ result, offsetLastRecord ];
}

DbCommand.prototype.setRows = function( rows )
{	
	this.result.rows = this.result.rows.concat( rows );
	this.result.rowCountReceived += rows.length;
}

function DbResultSet()
{
	this.resultType = '';
	this.statementID = 0;
	this.commandCount = 0;
	this.columnCount = 0;
	this.rowCount = 0;
	this.errors = null;
	this.rows = [];
	this.fields = [];
}

function DbConnectionPool( options )
{
	this.options = options;
	this.pool = [];
}

DbConnectionPool.prototype.getConnection = function( callback )
{
	var connection = null;
	
	for( var i = 0 ; i < this.pool.length ; i++ ) {
		if( this.pool[i].available ) {
			connection = this.pool[i];
			connection.available = false;
			callback( null, connection );
		}
	}
	
	if( connection == null ) {
		var pool = this;
		connection = DbConnection.createConnection( this.options );
		connection.available = false;
		connection.release = function() {
			pool.release( this );
		}
		this.pool.push( connection );
		connection.connect( function ( errors ) {
			callback( errors, errors ? null : connection );
		} );
	}
}

DbConnectionPool.prototype.release = function( connection )
{
	var index = this.pool.indexOf( connection );
	if( index != -1 ) {
		connection.available = true;
		this.pool.splice( index, 1 );
		this.pool.push( connection );
	}
}

DbConnectionPool.prototype.end = function()
{
	for( var i = 0 ; i < this.pool.length ; i++ ) {
		connection = this.pool[i];
		connection.end();
	}
	
	this.pool = [];
}

DbConnectionPool.prototype.query = function( sql, params, callback )
{
	var args = Array.prototype.slice.call( arguments, 0, arguments.length );
	this.getConnection( function( errors, connection ) {
		if( errors ) {
			callback( errors, null, null );
		} else {
			connection.query.apply( connection, args );
		}
	} );
}

// Utilities

function md5( value )
{
	var hash = crypto.createHash('md5').update( value ).digest('hex');
	return hash;
}

function splitList( value )
{
	var array = [];
	
	if( value.indexOf( '[') != -1 ) {
		array = value.split( /\[(\w+)\]\s*/ ).filter( function( value ) { return value.length > 0 } );
	} else {
		array = value.split( ' ' );
	}
	
	return array;
}

function base64Decode( b64string ) {
	var buf = Buffer.from( b64string, 'base64' );
	buf = buf.toString( 'utf8' );
	return buf;
}

function prepareSQL( sql, params )
{
	if( typeof params == 'object' )
	{
		// Replace place holders that start with the $ sign with their actual values
		sql = sql.replace( /\$\w+/gi, function( key ) {
			key = key.substr( 1, key.length );
			var value = params[key];
			// Wrap the string with single quotes if needed
			if( typeof value == 'string' )
				value = "'" + value.replace( /'/g, "\'" ) + "'";
			else if( typeof value == 'undefined' )
				throw new Error( "Key '" + key + "' is undefined in sql '" + sql + "'" );
			return value;
		} );
	}

	return sql;
}

module.exports = DbFactory;
