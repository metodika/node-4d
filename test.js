var fourd = require( "./node-4d" );
// var settings = { host: '192.168.178.100', port: 19812, user: 'Rob Laveaux', password: 'laveaux' };
var settings = { host: 'localhost', port: 19812, user: 'Rob Laveaux', password: 'laveaux' };

var db = fourd.createConnection( settings );

db.connect( function() {
	
	db.query( "SELECT * FROM Artikel WHERE Omschrijving LIKE $0", ['Losan*'], function( errors, results, fields ) {
		console.log( results );
		db.logout();
		db.close();
	} );

	
} );

