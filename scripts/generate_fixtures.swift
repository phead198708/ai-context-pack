#!/usr/bin/env swift
import AppKit
import CoreGraphics
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let output = root.appendingPathComponent("fixtures/media", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func png(
  named name: String,
  text: String,
  fontSize: CGFloat = 54,
  weight: NSFont.Weight = .medium
) throws -> URL {
  let size = NSSize(width: 900, height: 300)
  let image = NSImage(size: size)
  image.lockFocus()
  NSColor.white.setFill(); NSRect(origin: .zero, size: size).fill()
  let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: fontSize, weight: weight), .foregroundColor: NSColor.black]
  text.draw(in: NSRect(x: 48, y: 100, width: 804, height: 100), withAttributes: attributes)
  image.unlockFocus()
  guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) else { throw FixtureError.renderFailed }
  let url = output.appendingPathComponent(name); try data.write(to: url); return url
}

func orientedJpeg(named name: String, sourceURL: URL) throws {
  guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
        let colorSpace = image.colorSpace,
        let context = CGContext(
          data: nil,
          width: image.height,
          height: image.width,
          bitsPerComponent: 8,
          bytesPerRow: 0,
          space: colorSpace,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw FixtureError.renderFailed }
  context.translateBy(x: CGFloat(image.height), y: 0)
  context.rotate(by: .pi / 2)
  context.draw(
    image,
    in: CGRect(x: 0, y: 0, width: image.width, height: image.height)
  )
  guard let rotated = context.makeImage() else { throw FixtureError.renderFailed }
  let url = output.appendingPathComponent(name)
  guard let destination = CGImageDestinationCreateWithURL(
    url as CFURL,
    "public.jpeg" as CFString,
    1,
    nil
  ) else { throw FixtureError.renderFailed }
  CGImageDestinationAddImage(
    destination,
    rotated,
    [
      kCGImagePropertyOrientation: 6 as NSNumber,
      kCGImagePropertyTIFFDictionary: [
        kCGImagePropertyTIFFOrientation: 6 as NSNumber,
      ],
      kCGImageDestinationLossyCompressionQuality: 0.95,
    ] as CFDictionary
  )
  guard CGImageDestinationFinalize(destination) else {
    throw FixtureError.renderFailed
  }
}

func corruptImage() throws {
  let bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00])
  try bytes.write(to: output.appendingPathComponent("ocr-corrupt.png"))
}

func textPdf() throws {
  let url = output.appendingPathComponent("text-one-page.pdf")
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  guard let context = CGContext(url as CFURL, mediaBox: &box, nil) else { throw FixtureError.renderFailed }
  context.beginPDFPage(nil)
  let graphics = NSGraphicsContext(cgContext: context, flipped: false)
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
  ("Synthetic PDF fixture" as NSString).draw(at: NSPoint(x: 72, y: 650), withAttributes: [.font: NSFont.systemFont(ofSize: 24), .foregroundColor: NSColor.black])
  NSGraphicsContext.restoreGraphicsState(); context.endPDFPage(); context.closePDF()
}

func scannedPdf(imageURL: URL) throws {
  guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw FixtureError.renderFailed }
  let url = output.appendingPathComponent("scanned-one-page.pdf")
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  guard let context = CGContext(url as CFURL, mediaBox: &box, nil) else { throw FixtureError.renderFailed }
  context.beginPDFPage(nil); context.draw(image, in: CGRect(x: 36, y: 280, width: 540, height: 180)); context.endPDFPage(); context.closePDF()
}

func mixedPdf(imageURL: URL) throws {
  guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw FixtureError.renderFailed
  }
  let url = output.appendingPathComponent("mixed-two-page.pdf")
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  guard let context = CGContext(url as CFURL, mediaBox: &box, nil) else {
    throw FixtureError.renderFailed
  }
  context.beginPDFPage(nil)
  let graphics = NSGraphicsContext(cgContext: context, flipped: false)
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
  ("Synthetic embedded page" as NSString).draw(
    at: NSPoint(x: 72, y: 650),
    withAttributes: [.font: NSFont.systemFont(ofSize: 24), .foregroundColor: NSColor.black]
  )
  NSGraphicsContext.restoreGraphicsState(); context.endPDFPage()
  context.beginPDFPage(nil)
  context.draw(image, in: CGRect(x: 36, y: 280, width: 540, height: 180))
  context.endPDFPage(); context.closePDF()
}

func corruptPdf() throws {
  let bytes = Data("%PDF-1.7\n1 0 obj\n<< /Type /Catalog\n".utf8)
  try bytes.write(to: output.appendingPathComponent("corrupt-truncated.pdf"))
}

enum FixtureError: Error { case renderFailed }
let english = try png(
  named: "ocr-english.png",
  text: "TypeError E42 retry import",
  fontSize: 48
)
_ = try png(
  named: "ocr-chinese.png",
  text: "合成测试：重新导入",
  fontSize: 64,
  weight: .regular
)
try orientedJpeg(named: "ocr-rotated.jpg", sourceURL: english)
try corruptImage()
try textPdf()
try scannedPdf(imageURL: english)
try mixedPdf(imageURL: english)
try corruptPdf()
