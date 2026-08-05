#!/usr/bin/env swift
import AppKit
import CoreGraphics
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let output = root.appendingPathComponent("fixtures/media", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func png(named name: String, text: String) throws -> URL {
  let size = NSSize(width: 900, height: 300)
  let image = NSImage(size: size)
  image.lockFocus()
  NSColor.white.setFill(); NSRect(origin: .zero, size: size).fill()
  let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 54, weight: .medium), .foregroundColor: NSColor.black]
  text.draw(in: NSRect(x: 48, y: 100, width: 804, height: 100), withAttributes: attributes)
  image.unlockFocus()
  guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) else { throw FixtureError.renderFailed }
  let url = output.appendingPathComponent(name); try data.write(to: url); return url
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
let english = try png(named: "ocr-english.png", text: "Synthetic error: retry import")
_ = try png(named: "ocr-chinese.png", text: "合成测试：重新导入")
try textPdf()
try scannedPdf(imageURL: english)
try mixedPdf(imageURL: english)
try corruptPdf()
