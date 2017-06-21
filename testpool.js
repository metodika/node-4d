// Implement max-size for connection pool

var fourd = require( "./node-4d" );
// var settings = { host: '192.168.178.100', port: 19812, user: 'Rob Laveaux', password: 'laveaux' };
var settings = { host: 'localhost', port: 19812, user: 'Rob Laveaux', password: 'laveaux' };

try {
	
	var pool = fourd.createPool( settings );
//	pool.getConnection( function( errors, db ) {
//		if( errors ) {
//			console.log( errors );
//			return;
//		}
//		db.query( "SELECT * FROM Volgnummer ", ['Noppies%'], function( errors, results, fields ) {
//			console.log( fields );
//			console.log( results );
//			db.end();
//		} );
//	} );
	
	pool.query( "SELECT * FROM ArtikelGroep ", ['Noppies%'], function( errors, results, fields ) {
		console.log( fields );
		console.log( results );
	} );
	
	
}
catch( error ) {
	console.log( error );
}
