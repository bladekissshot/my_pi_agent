import AppKit
let folder = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
for (name, size) in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),("icon_32x32@2x",64),("icon_128x128",128),("icon_128x128@2x",256),("icon_256x256",256),("icon_256x256@2x",512),("icon_512x512",512),("icon_512x512@2x",1024)] {
 let rep = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
 let context = NSGraphicsContext(bitmapImageRep:rep)!
 NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current=context
 let n = CGFloat(size)
 let rect = NSRect(x:n*0.06,y:n*0.06,width:n*0.88,height:n*0.88)
 let path = NSBezierPath(roundedRect:rect,xRadius:n*0.20,yRadius:n*0.20)
 NSGradient(starting:NSColor(calibratedRed:0.13,green:0.35,blue:0.38,alpha:1),ending:NSColor(calibratedRed:0.04,green:0.12,blue:0.16,alpha:1))!.draw(in:path,angle:270)
 let attrs:[NSAttributedString.Key:Any] = [.font:NSFont.systemFont(ofSize:n*0.67,weight:.medium),.foregroundColor:NSColor(calibratedRed:0.68,green:0.96,blue:0.85,alpha:1)]
 let text = "π" as NSString; let bounds=text.size(withAttributes:attrs)
 text.draw(at:NSPoint(x:(n-bounds.width)/2,y:(n-bounds.height)/2+n*0.035),withAttributes:attrs)
 NSGraphicsContext.restoreGraphicsState()
 try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:folder+"/"+name+".png"))
}
