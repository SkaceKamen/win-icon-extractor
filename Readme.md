# Windows Icon Extractor

This module attempts to extract icons of any windows path and returns PNG represented by base64 string.

## Limitations

 - only runs on windows (uses internal windows libraries)
 - the result is always 32x32

## Changelog
### 1.0.4

 - Unicode paths accepted now!
 - Fixed occasional failture to load icon (caused by wrong memory management)
 - Fixed possible memory leak


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