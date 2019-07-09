path   = require 'path'
ffi    = require 'ffi-napi'
ref    = require 'ref'
struct = require 'ref-struct'
fs     = require 'fs'
jimp   = require 'jimp'
bmp_js = require 'bmp-js'

IntPtr = ref.refType ref.types.int
HANDLE = ref.refType ref.types.void

lpctstr = 
    indirection:    1
    name:           'lpctstr'
    size:           ref.sizeof.pointer
    ffi_type:       ffi.types.CString.ffi_type
    get:            (buffer, offset) -> 
        _buf = buffer.readPointer offset
        return null if _buf.isNull()
        _buf.readCString 0
    set:            (buffer, offset, value) ->
        _buf = Buffer.alloc Buffer.byteLength(value, 'ucs2')+2
        _buf.write value, 'ucs2'
        _buf[_buf.length-2] = 0
        _buf[_buf.length-1] = 0
        buffer.writePointer _buf, offset

iconInfo = struct 
    fIcon:    ref.types.bool
    xHotspot: ref.types.ulong
    yHotspot: ref.types.ulong
    hbmMask:  HANDLE
    hbmColor: HANDLE

bitmapInfoHeader = struct
    biSize:          ref.types.ulong
    biWidth:         ref.types.long
    biHeight:        ref.types.long
    biPlanes:        ref.types.ushort
    biBitCount:      ref.types.ushort
    biCompression:   ref.types.ulong
    biSizeImage:     ref.types.ulong
    biXPelsPerMeter: ref.types.long
    biYPelsPerMeter: ref.types.long
    biClrUsed:       ref.types.ulong
    biClrImportant:  ref.types.ulong

palleteColor = struct
    red:   ref.types.uint8
    greed: ref.types.uint8
    blue:  ref.types.uint8
    void:  ref.types.uint8

bitmapInfo = struct bmiHeader:bitmapInfoHeader 

# Allocate color table for 16 colors
# The table size is dynamic, but needs to be preallocated
# After we load the actual table size, we slice unused part off
for i in [0...16]
    bitmapInfo.defineProperty 'color' + i, palleteColor

shell32 = ffi.Library 'shell32', ExtractAssociatedIconW: ["void *", [IntPtr, lpctstr, IntPtr]]

gdi32 = ffi.Library 'gdi32', GetDIBits: [ref.types.int32, [IntPtr, IntPtr, 'uint32', 'uint32', IntPtr, ref.refType(bitmapInfo), 'uint32'] ]

user32 = ffi.Library 'user32', 
    GetIconInfo: ['bool', [IntPtr, ref.refType(iconInfo)]]
    GetDC:       [HANDLE, [IntPtr]]
    DestroyIcon: ['bool', [HANDLE]]

loadBitmap = (hbitmap, ident) ->
    bitmap = new bitmapInfo()
    
    # Clear bitmap info
    bitmap['ref.buffer'].fill 0

    # Save the bmiheader size
    bitmap.bmiHeader.biSize = 40

    # Load bitmap details
    dc = user32.GetDC null
    if dc.deref() == 0
        throw new Error "Failed to get screen DC."
    
    if gdi32.GetDIBits(dc, hbitmap, 0, 0, null, bitmap.ref(), 0) == 0
        throw new Error "Failed to load BITMAP (" + ident + ") info."

    # Slice off the unused color table
    colors = bitmap.bmiHeader.biBitCount < 24 and ((1 << bitmap.bmiHeader.biBitCount) * 4) or 0
    bitmap['ref.buffer'] = bitmap['ref.buffer'].slice 0, bitmap.bmiHeader.biSize + colors

    # Disable compression
    bitmap.bmiHeader.biCompression = 0

    # Load bitmap data
    data = Buffer.alloc bitmap.bmiHeader.biSizeImage
    if gdi32.GetDIBits(dc, hbitmap, 0, bitmap.bmiHeader.biHeight, data, bitmap.ref(), 0) == 0
        throw new Error "Failed to load BITMAP data."

    # Prepare BMP header
    header = Buffer.alloc 2 + 4 + 4 + 4
    
    # BMP signature (BM)
    header.writeUInt8 66, 0
    header.writeUInt8 77, 1
    # Size fo the BMP file, HEADER + COLOR_TABLE + DATA
    header.writeUInt32LE data.byteLength + 54 + colors, 2
    # Reserved
    header.writeUInt32LE 0, 6
    # Offset of actual image data HEADER + COLOR_TABLE
    header.writeUInt32LE 54 + colors, 10

    # Return resulting BMP file
    data:  Buffer.concat [header, bitmap.ref(), data]
    depth: bitmap.bmiHeader.biBitCount

module.exports = (target) ->
    
    new Promise (resolve, reject) =>
        
        # Make sure the path is absolute
        target = path.resolve target

        # Load icon data
        iconIndex = ref.alloc ref.types.int32, 0
        info = new iconInfo()
        
        # Clear info struct
        info['ref.buffer'].fill 0

        result = shell32.ExtractAssociatedIconW null, target, iconIndex
        if not user32.GetIconInfo result, info.ref()
            throw new Error "Failed to load icon info."
        
        # Load icon bitmaps
        colored = loadBitmap info.hbmColor, 'colored'
        mask = loadBitmap info.hbmMask, 'mask'

        # Remove icon from memory
        user32.DestroyIcon result

        # Load bitmaps into standardized formats
        colored_bmp = bmp_js.decode colored.data
        mask_bmp = bmp_js.decode mask.data

        # Load the colored bmp
        # Little hack has to be applied, jimp currently doesn't support 32 bit BMP
        # Encoder uses 24 bit, so it loads fine
        jimp.read bmp_js.encode(colored_bmp).data, (err, colored_img) => 
            if (err) then return reject err

            # Bitmap can have 32 bits per color, but ignore the aplha channel
            has_alpha = false

            # 32 bit BMP can have alpha encoded, so we may not need the mask
            if colored.depth > 24
                # Scan the original BMP image, if any pixel has > 0 alpha, the mask wont be needed
                for xx in [0...colored_bmp.width] 
                    for yy in [0...colored_bmp.height] 
                        index = colored_img.getPixelIndex xx, yy
                        if colored_bmp.data[index + 3] != 0
                            has_alpha = true
                            break

            # Ignore mask, if the colored icon has alpha encoded already (most does)
            if has_alpha
                # Little hack again, assign actual RGBA data to image
                colored_img.bitmap = colored_bmp
                colored_img.getBase64 jimp.MIME_PNG, (error, base64) => 
                    if (err) then return reject err
                    resolve base64
            else 
                # Load mask and apply it
                jimp.read bmp_js.encode(mask_bmp).data, (err, mask_img) =>
                    if (err) then return reject err
                     
                    masked_img = colored_img.mask(mask_img.invert(), 0, 0)
                    masked_img.getBase64 jimp.MIME_PNG, (error, base64) =>
                        if (err) then return reject err
                        resolve base64
