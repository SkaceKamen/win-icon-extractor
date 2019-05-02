var path = require('path');
var ffi = require('ffi');
var ref = require('ref');
var struct = require('ref-struct');
var fs = require('fs');
var jimp = require('jimp');
var bmp_js = require('bmp-js');

var IntPtr = ref.refType(ref.types.int);
var HANDLE = ref.refType(ref.types.void);

var lpctstr = {
	name: 'lpctstr',
	indirection: 1,
	size: ref.sizeof.pointer,
	get: function(buffer, offset) {
		var _buf = buffer.readPointer(offset);
		if(_buf.isNull()) {
			return null;
		}
		return _buf.readCString(0);
	},
	set: function(buffer, offset, value) {
        var _buf = Buffer.alloc(Buffer.byteLength(value, 'ucs2') + 2)
		_buf.write(value, 'ucs2')
		_buf[_buf.length - 2] = 0
		_buf[_buf.length - 1] = 0
		return buffer.writePointer(_buf, offset)
	},
	ffi_type: ffi.types.CString.ffi_type
};

var iconInfo = struct({
	'fIcon': ref.types.bool,
	'xHotspot': ref.types.ulong,
	'yHotspot': ref.types.ulong,
	'hbmMask': HANDLE,
	'hbmColor': HANDLE
});

var bitmapInfoHeader = struct({
	biSize: ref.types.ulong,
	biWidth: ref.types.long,
	biHeight: ref.types.long,
	biPlanes: ref.types.ushort,
	biBitCount: ref.types.ushort,
	biCompression: ref.types.ulong,
	biSizeImage: ref.types.ulong,
	biXPelsPerMeter: ref.types.long,
	biYPelsPerMeter: ref.types.long,
	biClrUsed: ref.types.ulong,
	biClrImportant: ref.types.ulong
});

var palleteColor = struct({
	red: ref.types.uint8,
	greed: ref.types.uint8,
	blue: ref.types.uint8,
	void: ref.types.uint8
});

var bitmapInfo = struct({
	bmiHeader: bitmapInfoHeader
});

// Allocate color table for 16 colors
// The table size is dynamic, but needs to be preallocated
// After we load the actual table size, we slice unused part off
for (var i = 0; i < 16; i++) {
	bitmapInfo.defineProperty('color' + i, palleteColor);
}

var shell32 = ffi.Library('shell32', {
	'ExtractAssociatedIconW': ["void *", [IntPtr, lpctstr, IntPtr]]
});
var gdi32 = ffi.Library('gdi32', {
	'GetDIBits': [ref.types.int32, [IntPtr, IntPtr, 'uint32', 'uint32', IntPtr, ref.refType(bitmapInfo), 'uint32'] ]
});
var user32 = ffi.Library('user32', {
	'GetIconInfo': ['bool', [IntPtr, ref.refType(iconInfo)]],
	'GetDC': [HANDLE, [IntPtr]],
	'DestroyIcon': ['bool', [HANDLE]]
});

function loadBitmap(hbitmap, ident) {
	var bitmap = new bitmapInfo();
	
	// Clear bitmap info
	bitmap['ref.buffer'].fill(0);

	// Save the bmiheader size
	bitmap.bmiHeader.biSize = 40;

	// Load bitmap details
	var dc = user32.GetDC(null);
	if (dc.deref() == 0) {
		throw new Error("Failed to get screen DC.");
	}
	
	if (gdi32.GetDIBits(dc, hbitmap, 0, 0, null, bitmap.ref(), 0) == 0) {
		throw new Error("Failed to load BITMAP (" + ident + ") info.");
	}

	// Slice off the unused color table
	var colors = bitmap.bmiHeader.biBitCount < 24 ? ((1 << bitmap.bmiHeader.biBitCount) * 4) : 0;
	bitmap['ref.buffer'] = bitmap['ref.buffer'].slice(0, bitmap.bmiHeader.biSize + colors);

	// Disable compression
	bitmap.bmiHeader.biCompression = 0;

	// Load bitmap data
    var data = Buffer.alloc(bitmap.bmiHeader.biSizeImage);
	if (gdi32.GetDIBits(dc, hbitmap, 0, bitmap.bmiHeader.biHeight, data, bitmap.ref(), 0) == 0) {
		throw new Error("Failed to load BITMAP data.");
	}

	// Prepare BMP header
    var header = Buffer.alloc(2 + 4 + 4 + 4);
	
	// BMP signature (BM)
	header.writeUInt8(66, 0);
	header.writeUInt8(77, 1);
	// Size fo the BMP file, HEADER + COLOR_TABLE + DATA
	header.writeUInt32LE(data.byteLength + 54 + colors, 2);
	// Reserved
	header.writeUInt32LE(0, 6);
	// Offset of actual image data HEADER + COLOR_TABLE
	header.writeUInt32LE(54 + colors, 10);

	// Return resulting BMP file
	return {
		data: Buffer.concat([header, bitmap.ref(), data]),
		depth: bitmap.bmiHeader.biBitCount
	};
}

module.exports = function(target) {
	return new Promise((resolve, reject) => {
		// Make sure the path is absolute
		target = path.resolve(target);

		// Load icon data
		var iconIndex = ref.alloc(ref.types.int32, 0);
		var info = new iconInfo();
		
		// Clear info struct
		info['ref.buffer'].fill(0);

		var result = shell32.ExtractAssociatedIconW(null, target, iconIndex);
		if (!user32.GetIconInfo(result, info.ref())) {
			throw new Error("Failed to load icon info.");
		}
		
		// Load icon bitmaps
		var colored = loadBitmap(info.hbmColor, 'colored');
		var mask = loadBitmap(info.hbmMask, 'mask');

		// Remove icon from memory
		user32.DestroyIcon(result);

		// Load bitmaps into standardized formats
		var colored_bmp = bmp_js.decode(colored.data);
		var mask_bmp = bmp_js.decode(mask.data);

		// Load the colored bmp
		// Little hack has to be applied, jimp currently doesn't support 32 bit BMP
		// Encoder uses 24 bit, so it loads fine
		jimp.read(bmp_js.encode(colored_bmp).data, (err, colored_img) => {
			if (err) return reject(err);

			// Bitmap can have 32 bits per color, but ignore the aplha channel
			var has_alpha = false;

			// 32 bit BMP can have alpha encoded, so we may not need the mask
			if (colored.depth > 24) {			
				// Scan the original BMP image, if any pixel has > 0 alpha, the mask wont be needed
				for (var xx = 0; xx < colored_bmp.width; xx++) {
					for (var yy = 0; yy < colored_bmp.height; yy++) {
						var index = colored_img.getPixelIndex(xx, yy);
						if (colored_bmp.data[index + 3] != 0) {
							has_alpha = true;
							break;
						}
					}
				}
			}

			// Ignore mask, if the colored icon has alpha encoded already (most does)
			if (has_alpha) {
				// Little hack again, assign actual RGBA data to image
				colored_img.bitmap = colored_bmp;
				colored_img.getBase64(jimp.MIME_PNG, (error, base64) => {
					if (err) return reject(err);
					
					resolve(base64);
				});
			} else {
				// Load mask and apply it
				jimp.read(bmp_js.encode(mask_bmp).data, (err, mask_img) => {
					if (err) return reject(err);
					
					var masked_img = colored_img.mask(mask_img.invert(), 0, 0);
					masked_img.getBase64(jimp.MIME_PNG, (error, base64) => {
						if (err) return reject(err);
						
						resolve(base64);
					});
				});
			}
		});
	});
}
