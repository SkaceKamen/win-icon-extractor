var assert = require('assert');
var loadIcon = require('../index');

describe('Basic loading', function() {
	it('should work for exe file', function() {
		return loadIcon("data/test.exe").catch((e) => { throw e });
	})

	it('should work for folder', function() {
		return loadIcon("data").catch((e) => { throw e });
	})

	it('should handle unicode paths', function() {
		return loadIcon("data/转注字/test.exe").catch((e) => { throw e });
	})
})

describe('Load test', function() {
	it('should work 500 times', function() {
		var promises = [];
		for (var i = 0; i < 500; i++) {
			promises.push(loadIcon("data/tests.exe"));
		}
		return Promise.all(promises).catch((e) => { throw e });
	})
})