// 小 OCR helper：macOS Vision 中文识别，输出 "text<TAB>x<TAB>y<TAB>w<TAB>h"。
// call-loop 用它读群语音邀请里的群名 / 接听按钮；不依赖网络或额外模型。
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
  fputs("usage: qq-ocr <image>\n", stderr)
  exit(64)
}
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fputs("cannot load image\n", stderr)
  exit(65)
}
let width = CGFloat(cg.width)
let height = CGFloat(cg.height)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([request])
} catch {
  fputs("ocr failed: \(error)\n", stderr)
  exit(66)
}
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let box = observation.boundingBox
  let x = box.origin.x * width
  let y = (1 - box.origin.y - box.size.height) * height
  let w = box.size.width * width
  let h = box.size.height * height
  print("\(candidate.string)\t\(Int(x))\t\(Int(y))\t\(Int(w))\t\(Int(h))")
}
