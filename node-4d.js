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

function DbConnection( options )
{
	this.port = options.port || 19812;
	this.host = options.host || '127.0.0.1';
	this.user = options.user || 'Administrator';
	this.password = options.password || '';
	this.options =  options;
	this.socket = null;
	this.connected = false;
	this.buffer = '';
	this.error = 0;
	this.errorMessage = '';
	this.nextCommandID = 1;
	this.affectedRows = 0;
	this.fetchLimit = 999999;
	this.queue = {};
	
	this.socket = new net.Socket();
	this.socket.setEncoding( 'utf8' );
	this.socket.setKeepAlive( true, 30 * 1000 );
	
	var self = this;
	var command = null;
	
	this.socket.setTimeout( 180 * 1000, function () {
		console.log( 'Socket timeout' );
		self.connected = false;
	} );
	
	this.socket.on( 'error', function ( error ) {
		console.log( 'Socket error: ', error );
	} );

	this.socket.on( 'data', function ( data ) {
		// Append the incoming data to the buffer
		console.log( 'OnData:' + data );
		self.buffer += data;

		while( packet = self.readPacket() ) {
			// Parse the headers
			var headers = parseHeaders( packet );
			var rows = null;
			
			if( headers ) {
				// We've received a new command, take the command from the command queue
				command = self.queue[headers.commandID];
			} else {
				// We're receiving the rows part of a command
				rows = parseRows( packet );
			}
			
			if( command ) {
				if( !command.result ) {
					command.result = {};
				}
				if( headers ) {
					command.result.headers = headers;
				}
				if( headers && command.callback ) {
					command.callback( headers );
				}
				if( rows && command.callback ) {
					command.callback( rows );
				}
			}
		}
	} );
}

DbConnection.prototype.readPacket = function()
{
	var pos = -1;
	var packet = null;

	// Check if we have a full packet inside the buffer (either header or data)
	if( this.buffer.match( /^\d+ \w+$/m ) ) {
		// We are receiving the headers
		pos = this.buffer.indexOf( '\r\n\r\n' );
		if( pos != -1 ) {
			// If so, extract the packet from the buffer
			packet = this.buffer.slice( 0, pos );
			this.buffer = this.buffer.substr( pos + 4 );
		}
	} else if( this.buffer.match( kCRLF ) ) {
		// We are receiving the rows
		if( this.buffer.endsWith( '\r' ) ) {
			// 4D ends all rows with CRLF except the last row
			// Fix this, by appending a LF
			this.buffer += '\n';
		}
		pos = this.buffer.lastIndexOf( '\r\n' );
		if( pos != -1 ) {
			// If so, extract the packet from the buffer
			pos += 2;	// Include the CRLF for the rows
			packet = this.buffer.slice( 0, pos );
			this.buffer = this.buffer.substr( pos );
		}
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
	console.log( 'Send Command: ' + command.request );
	this.socket.write( command.request );
	this.queue[command.commandID] = command;
}

DbConnection.prototype.login = function( userCallback )
{
	var self = this;
	console.log( 'Connecting' );
	
	this.socket.connect( this.port, this.host, function () {
		console.log( 'Connected' );
		var command = self.createCommand( 'LOGIN' );
		command.request += 'USER-NAME:' + self.user + kCRLF;
		command.request += 'USER-PASSWORD:' + self.password + kCRLF;
		command.request += 'REPLY-WITH-BASE64-TEXT:Y' + kCRLF;
		command.request += 'PROTOCOL-VERSION:13.0' + kCRLF;
		command.request += 'OS-NAME:' + os.platform() + kCRLF;
		command.request += 'OS-VERSION:' + os.release() + kCRLF;
		command.request += kCRLF;
		
		command.callback = function( data ) {
			self.connected = true;
			userCallback();
		}
		
		self.sendCommand( command );
		
	} );
}

DbConnection.prototype.connect = DbConnection.prototype.login;

DbConnection.prototype.logout = function()
{
	if( !this.connected ) {
		throw new Error( 'Cannot logout. Not connected to database' );
	}
	
	var command = this.createCommand( 'LOGOUT' );
	command.request += kCRLF;

	command.callback = function( data ) {
		this.connected = false;
	};

	this.sendCommand( command );
}

DbConnection.prototype.close = function()
{
	var command = this.createCommand( 'QUIT' );
	command.request += kCRLF;

	command.callback = function( data ) {
		this.connected = false;
	};

	this.sendCommand( command );
}

DbConnection.prototype.end = DbConnection.prototype.close;

DbConnection.prototype.query = function( sql, params, userCallback )
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
	command.request += 'OUTPUT-MODE:Debug' + kCRLF;
	command.request += 'PREFERRED-IMAGE-TYPES:jpg png' + kCRLF;
	command.request += 'FIRST-PAGE-SIZE:' + this.fetchLimit + kCRLF;
	command.request += 'FULL-ERROR-STACK:Y' + kCRLF;
	command.request += kCRLF;
	
	var self = this;

	command.callback = function( data ) {
		if( Array.isArray( data ) == false  ) {
			command.setResponseHeaders( data );
			if( command.result.errors ) {
				userCallback( command.result.errors, null, null );
			}
		} else {
			command.setRows( data );
			// Check if we need to fetch more rows
			if( command.result.rowCountReceived == command.result.rowCountSent && command.result.rows.length < command.result.rowCount ) {
				self.fetch( command.result, userCallback );
			} else if( command.result.rows.length == command.result.rowCount ) {
				// We have fetched all rows, run the callback
				userCallback( command.result.errors, command.result.rows, command.result.fields );
			}
		}
	}
	
	this.sendCommand( command );
}

DbConnection.prototype.fetch = function( result, userCallback )
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
	command.request += 'OUTPUT-MODE:Debug' + kCRLF;
	command.request += 'FIRST-ROW-INDEX:' + firstRow + kCRLF;
	command.request += 'LAST-ROW-INDEX:' + lastRow + kCRLF;
	command.request += 'FULL-ERROR-STACK:Y' + kCRLF;
	command.request += kCRLF;
	
	command.callback = function( data ) {
		if( Array.isArray( data ) == false ) {
			command.setResponseHeaders( data );
			if( command.result.errors ) {
				userCallback( command.result.errors, null, null );
			}
		} else {
			command.setRows( data );
			// Check if we need to fetch more rows
			if( command.result.rowCountReceived == command.result.rowCountSent && command.result.rows.length < command.result.rowCount ) {
				self.fetch( command.result, userCallback );
			} else if( command.result.rows.length == command.result.rowCount ) {
				// We have fetched all rows, run the callback
				userCallback( command.result.errors, command.result.rows, command.result.fields );
			}
		}
	}
	
	this.sendCommand( command );
}

DbConnection.createConnection = function( options )
{
	var db = new DbConnection( options );
	return db;
}

function DbCommand( id, type )
{
	this.commandID = ( '0000000000' + id ).substr( -10, 10 );
	this.type = type;
	this.status = '';
	this.request = this.commandID + ' ' + this.type + kCRLF;
	this.result = null;
	this.callback = null;
}

DbCommand.prototype.setResponseHeaders = function( headers )
{
	var result = new DbResultSet();
	this.result = result;
	
	if( headers.status == 'ERROR' ) {
		result.errors = {};
		result.errors.code = Number( headers.ErrorCode );
		result.errors.message = headers.ErrorDescription;
		if( headers.StackError1 )
			result.errors.message += '\n' + headers.StackError1;
		if( headers.StackError2 )
			result.errors.message += '\n' + headers.StackError2;
		if( headers.StackError3 )
			result.errors.message += '\n' + headers.StackError3;
		return;
	}
	
	result.resultType = headers.ResultType || 'ERROR';
	if( headers.ResultType == 'Result-Set' ) {
		result.statementID = headers.StatementID;
		result.commandCount = Number( headers.CommandCount );
		result.columnCount = Number( headers.CommandCount );
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
	} else if( result.resultType == 'Update-Count' ) {
		
	}
}

DbCommand.prototype.setRows = function( rows )
{
	for( var i = 0 ; i < rows.length ; i++ ) {
		var row = {};
		for( var j = 0 ; j < this.result.fields.length ; j++ ) {
			var field = this.result.fields[j].name;
			var type = this.result.fields[j].type;
			var value = rows[i][j];
			// Convert the value to its closest equivalent
			switch( type )
			{
				case 'VK_STRING' :
				case 'VK_TEXT' :
					break;
				case 'VK_LONG' :
				case 'VK_LONG8' :
				case 'VK_BYTE' :
				case 'VK_WORD' :
				case 'VK_REAL' :
				case 'VK_FLOAT' :
					value = Number( value );
					break;
				case 'VK_BOOLEAN' :
					value = ( value == 'true' );
					break;
				case 'VK_TIME' :
				case 'VK_TIMESTAMP' :
					// Is date- time value
					var items = value.match( /(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})/ );
					value = new Date( items[3] + '-' + items[2] + '-' + items[1] + ' ' + items[4] + ':' + items[5] );
					break;
				case 'VK_DURATION' :
					// Is time-only value (do not translate)
					break;
				case 'VK_BLOB' :
				case 'VK_IMAGE' :
					value = value ? Buffer.from( value, 'base64' ) : null;
					break;
			}
			row[field] = value;
		}
		this.result.rows.push( row );
	}

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
	this.lastInsertID = 0;
	this.affectedRows = 0;
}

// Utilities

function md5( value )
{
	var hash = crypto.createHash('md5').update( value ).digest('hex');
	return hash;
}

function parseHeaders( packet )
{
	var headers = {};
	
	if( packet.match( /^\d+ \w+$/m ) ) {
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
	} else {
		headers = null;
	}
	
	return headers;
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

function parseRows( buffer )
{
	// Split the text into rows
	var lines = buffer.split( kCRLF );

	// Remove the last line if it is empty
	if( lines[lines.length-1] == '' ) {
		lines.pop();
	}

	// Split the rows into columns
	var array = lines.map( function( line ) {
		return line.split( '\t' );
	} );

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

module.exports = DbConnection;
