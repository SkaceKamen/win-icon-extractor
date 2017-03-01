# Windows Icon Extractor

This module attempts to extract icons of any windows resource and returns PNG represented by base64 string.

## Limitations

 - the result has always 32x32
 - only ASCII paths accepted

## Installation

Using npm:

```
npm install win-icon-extractor --save
```

## Usage

This module consists of single exported function. This function returns promise, which returns base64 encoded png data.

```javascript

var extractIcon = require('win-icon-extractor');

extractIcon("binary.exe").then((result) => {
	// Prints "data:image/png;base64,iVB...."
	console.log(result);
});

```