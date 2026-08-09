#!/usr/bin/env swift
import AppKit
import CoreGraphics
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let output = root.appendingPathComponent("fixtures/media", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let issue11Only = CommandLine.arguments.contains("--issue-11")

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

private func drawPDFText(
  _ text: String,
  context: CGContext,
  point: NSPoint = NSPoint(x: 72, y: 650)
) {
  let graphics = NSGraphicsContext(cgContext: context, flipped: false)
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
  (text as NSString).draw(
    at: point,
    withAttributes: [
      .font: NSFont.systemFont(ofSize: 24),
      .foregroundColor: NSColor.black,
    ]
  )
  NSGraphicsContext.restoreGraphicsState()
}

private func issue11PDFOptions(title: String) -> [CFString: Any] {
  let fixedDate = Date(timeIntervalSince1970: 0)
  return [
    kCGPDFContextCreator: "AI Context Pack synthetic fixture generator",
    kCGPDFContextAuthor: "AI Context Pack",
    kCGPDFContextTitle: title,
    kCGPDFContextCreationDate: fixedDate,
    kCGPDFContextModificationDate: fixedDate,
  ]
}

func encryptedPdf() throws {
  let url = output.appendingPathComponent("encrypted-one-page.pdf")
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  var options = issue11PDFOptions(title: "Synthetic encrypted PDF")
  options.merge([
    kCGPDFContextUserPassword: "synthetic-password",
    kCGPDFContextOwnerPassword: "synthetic-owner-password",
    kCGPDFContextEncryptionKeyLength: 128,
  ]) { _, replacement in replacement }
  guard let context = CGContext(url as CFURL, mediaBox: &box, options as CFDictionary) else {
    throw FixtureError.renderFailed
  }
  context.beginPDFPage(nil)
  drawPDFText("Synthetic encrypted PDF", context: context)
  context.endPDFPage(); context.closePDF()
}

func emptyPdf() throws {
  let url = output.appendingPathComponent("empty-one-page.pdf")
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  guard let context = CGContext(
    url as CFURL,
    mediaBox: &box,
    issue11PDFOptions(title: "Synthetic empty PDF") as CFDictionary
  ) else {
    throw FixtureError.renderFailed
  }
  context.beginPDFPage(nil)
  context.endPDFPage(); context.closePDF()
}

func sparsePdf() throws {
  let url = output.appendingPathComponent("sparse-one-page.pdf")
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  guard let context = CGContext(
    url as CFURL,
    mediaBox: &box,
    issue11PDFOptions(title: "Synthetic sparse PDF") as CFDictionary
  ) else {
    throw FixtureError.renderFailed
  }
  context.beginPDFPage(nil)
  drawPDFText("A", context: context)
  context.endPDFPage(); context.closePDF()
}

func overPageLimitPdf() throws {
  let url = output.appendingPathComponent("over-limit-26-pages.pdf")
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  guard let context = CGContext(
    url as CFURL,
    mediaBox: &box,
    issue11PDFOptions(title: "Synthetic 26-page PDF") as CFDictionary
  ) else {
    throw FixtureError.renderFailed
  }
  for page in 1...26 {
    context.beginPDFPage(nil)
    drawPDFText("Synthetic page \(page) of 26", context: context)
    context.endPDFPage()
  }
  context.closePDF()
}

func mixedTwentyPagePdf(imageURL: URL) throws {
  guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw FixtureError.renderFailed
  }
  let url = output.appendingPathComponent("mixed-twenty-page.pdf")
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  guard let context = CGContext(
    url as CFURL,
    mediaBox: &box,
    issue11PDFOptions(title: "Synthetic 20-page mixed PDF") as CFDictionary
  ) else {
    throw FixtureError.renderFailed
  }
  for page in 1...20 {
    context.beginPDFPage(nil)
    if page.isMultiple(of: 2) {
      context.draw(image, in: CGRect(x: 36, y: 280, width: 540, height: 180))
    } else {
      drawPDFText("Synthetic embedded benchmark page \(page)", context: context)
    }
    context.endPDFPage()
  }
  context.closePDF()
}

enum FixtureError: Error { case renderFailed }
let english: URL
if issue11Only {
  english = output.appendingPathComponent("ocr-english.png")
  guard FileManager.default.fileExists(atPath: english.path) else {
    throw FixtureError.renderFailed
  }
} else {
  english = try png(
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
}
try encryptedPdf()
try emptyPdf()
try sparsePdf()
try overPageLimitPdf()
try mixedTwentyPagePdf(imageURL: english)
