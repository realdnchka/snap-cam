// SnapCam: one shot from iPhone (Continuity) or Desk View, with a zoom frame.
// Usage: SnapCam <iphone|desk|list> <out.jpg> <manual|delaySec> [statusFile] [off|on|auto|""] [zoom]
import AppKit
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "iphone"
let outPath = args.count > 2 ? args[2] : NSHomeDirectory() + "/Pictures/ClaudeSnaps/snap.jpg"
let statusPath = args.count > 4 ? args[4] : outPath + ".status"
let stateDir = NSHomeDirectory() + "/Library/Application Support/snap-cam"
// A number shoots by itself after that many seconds; "manual" waits for the user.
let autoDelay: Double? = args.count > 3 ? Double(args[3]).map { min(max($0, 0), 60) } : nil
let flashArg = args.count > 5 ? args[5] : ""
// One-shot zoom for this run; not saved.
let zoomArg: CGFloat? = args.count > 6 ? Double(args[6]).map { CGFloat(min(max($0, 1), 3)) } : nil
let flashPath = "\(stateDir)/flash.txt"
let flashModes = ["off", "on", "auto"]

func loadFlash() -> String {
    let v = (try? String(contentsOfFile: flashPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    return flashModes.contains(v ?? "") ? v! : "off"
}

// Likely cause when Continuity gives only black placeholder frames; macOS doesn't say why.
let continuityBlocked = "Continuity Camera не запустилась: macOS не дала камере iPhone канал Wi‑Fi "
    + "(обычно мешает Sidecar — iPad как второй экран, или режим модема). "
    + "Отключи Sidecar или сними через приложение SnapCam на iPhone."

// Diagnostics for a failed run: where it stopped and what the camera looked like.
var step = "поиск камеры"
var diagDevice: AVCaptureDevice?
var diagSession: AVCaptureSession?
var framesSeen = 0
var brightFrames = 0

func describe(_ error: Error?) -> String {
    guard let e = error as NSError? else { return "" }
    var text = "\(e.domain) \(e.code)"
    if let under = e.userInfo[NSUnderlyingErrorKey] as? NSError { text += " ← \(under.domain) \(under.code)" }
    return text
}

func errorChain(_ error: Error?) -> String {
    var lines: [String] = []
    var next = error as NSError?
    while let e = next {
        lines.append("\(e.domain) \(e.code) \(e.userInfo)")
        next = e.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return lines.joined(separator: " ← ")
}

func logDebug(_ code: Int32, _ msg: String, _ error: Error?) {
    var fields = ["exit=\(code)", "step=\(step)"]
    if let d = diagDevice {
        fields += ["device=\(d.localizedName)", "type=\(d.deviceType.rawValue)", "connected=\(d.isConnected)"]
        if #available(macOS 14.0, *) { fields.append("suspended=\(d.isSuspended)") }
    }
    fields += ["running=\(diagSession?.isRunning ?? false)", "frames=\(framesSeen)", "bright=\(brightFrames)"]
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(fields.joined(separator: " ")) msg=\(msg)"
        + (error.map { " error=\(errorChain($0))" } ?? "") + "\n"
    let path = "\(stateDir)/debug.log"
    try? FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
    if let h = FileHandle(forWritingAtPath: path) {
        h.seekToEndOfFile()
        h.write(Data(line.utf8))
        h.closeFile()
    } else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
    }
}

func finish(_ code: Int32, _ msg: String, _ error: Error? = nil) -> Never {
    if code != 0, msg != "Отменено" { logDebug(code, msg, error) }
    try? msg.write(toFile: statusPath, atomically: true, encoding: .utf8)
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

// Failure with the step and error code appended, e.g. «(шаг: снимок; NSOSStatusErrorDomain 2)».
func fail(_ code: Int32, _ msg: String, _ error: Error? = nil) -> Never {
    let detail = describe(error)
    finish(code, "\(msg) (шаг: \(step)\(detail.isEmpty ? "" : "; " + detail))", error)
}

// Zoom keeps the centred 1/zoom of the frame, per camera kind.
func zoomPath(_ kind: String) -> String { "\(stateDir)/\(kind)-zoom.txt" }

func loadZoom(_ kind: String) -> CGFloat {
    let text = try? String(contentsOfFile: zoomPath(kind), encoding: .utf8)
    let v = text.flatMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? 1
    return CGFloat(min(max(v, 1), 3))
}

func storeZoom(_ kind: String, _ z: CGFloat) {
    try? FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
    try? String(format: "%.1f", z).write(toFile: zoomPath(kind), atomically: true, encoding: .utf8)
}

func allDevices() -> [AVCaptureDevice] {
    var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .external]
    if #available(macOS 14.0, *) { types += [.continuityCamera] }
    if #available(macOS 13.0, *) { types += [.deskViewCamera] }
    return AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified).devices
}

func isContinuity(_ d: AVCaptureDevice) -> Bool {
    if #available(macOS 14.0, *), d.deviceType == .continuityCamera { return true }
    return d.localizedName.localizedCaseInsensitiveContains("iphone")
}

func isDesk(_ d: AVCaptureDevice) -> Bool {
    if #available(macOS 13.0, *) { return d.deviceType == .deskViewCamera }
    return false
}

func pick(_ kind: String, _ list: [AVCaptureDevice]) -> AVCaptureDevice? {
    if kind == "desk" {
        return list.first { isDesk($0) && $0.localizedName.localizedCaseInsensitiveContains("iphone") }
            ?? list.first(where: isDesk)
    }
    return list.first(where: isContinuity)
}

func centreCrop(_ r: CGRect, _ z: CGFloat) -> CGRect {
    let w = r.width / z, h = r.height / z
    return CGRect(x: r.midX - w / 2, y: r.midY - h / 2, width: w, height: h).integral
}

// Long side cap keeps files light for the model.
func capped(_ img: CGImage, _ maxSide: Int = 2400) -> CGImage {
    let side = max(img.width, img.height)
    guard side > maxSide else { return img }
    let k = CGFloat(maxSide) / CGFloat(side)
    let w = Int(CGFloat(img.width) * k), h = Int(CGFloat(img.height) * k)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return img }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? img
}

func writeJPEG(_ img: CGImage) -> Bool {
    let url = URL(fileURLWithPath: outPath)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dst = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    return CGImageDestinationFinalize(dst)
}

func saveJPEG(_ data: Data, zoom: CGFloat) -> Bool {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return false }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 8000,
    ]
    guard let full = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary),
          let cut = full.cropping(to: centreCrop(CGRect(x: 0, y: 0, width: full.width, height: full.height), zoom))
    else { return false }
    return writeJPEG(capped(cut))
}

final class Snapper: NSObject, NSWindowDelegate, AVCapturePhotoCaptureDelegate, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let photo = AVCapturePhotoOutput()
    let video = AVCaptureVideoDataOutput()
    let queue = DispatchQueue(label: "frames")
    var usePhoto = false
    var wantFrame = false
    var done = false
    var window: NSWindow!
    var preview: AVCaptureVideoPreviewLayer!
    var device: AVCaptureDevice?
    var kind = mode == "desk" ? "desk" : "iphone"
    var zooms: [String: CGFloat] = [
        "desk": mode == "desk" ? zoomArg ?? loadZoom("desk") : loadZoom("desk"),
        "iphone": mode == "desk" ? loadZoom("iphone") : zoomArg ?? loadZoom("iphone"),
    ]
    var zoom: CGFloat { zooms[kind] ?? 1 }
    let shade = CAShapeLayer()
    let frameLine = CAShapeLayer()
    var flash = flashModes.contains(flashArg) ? flashArg : loadFlash()
    var left: Int?
    var sentFlash = "none"

    override init() {
        super.init()
        video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        video.setSampleBufferDelegate(self, queue: queue)
    }

    func attach(_ d: AVCaptureDevice) {
        device = d
        diagDevice = d
        diagSession = session
        watch(d)
        queue.async {
            let s = self.session
            s.stopRunning()
            s.beginConfiguration()
            s.inputs.forEach { s.removeInput($0) }
            s.outputs.forEach { s.removeOutput($0) }
            s.sessionPreset = isDesk(d) ? .high : .photo
            step = "открытие камеры"
            let input: AVCaptureDeviceInput
            do {
                input = try AVCaptureDeviceInput(device: d)
            } catch {
                fail(3, "Не удалось открыть камеру «\(d.localizedName)»", error)
            }
            guard s.canAddInput(input) else { fail(3, "Не удалось открыть камеру «\(d.localizedName)»") }
            step = "настройка"
            s.addInput(input)
            self.usePhoto = !isDesk(d) && s.canAddOutput(self.photo)
            if self.usePhoto { s.addOutput(self.photo) }
            if s.canAddOutput(self.video) { s.addOutput(self.video) }
            s.commitConfiguration()
            if self.usePhoto { self.pickBiggestPhotoFormat() }
            step = "запуск"
            s.startRunning()
            step = "превью"
            DispatchQueue.main.async {
                self.updateOverlay()
                // Warm-up lets exposure settle before an automatic shot.
                if let autoDelay {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.countdown(Int(autoDelay.rounded(.up))) }
                }
            }
        }
    }

    // A runtime error or a lost device ends the run now, not at the shot.
    func watch(_ d: AVCaptureDevice) {
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { [weak self] n in
            guard let self, !self.done else { return }
            let error = n.userInfo?[AVCaptureSessionErrorKey] as? Error
            fail(8, self.looksBlocked() ? continuityBlocked : "Камера остановилась с ошибкой", error)
        }
        nc.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: d, queue: .main) { [weak self] _ in
            guard let self, !self.done else { return }
            fail(7, "Камера «\(d.localizedName)» отключилась — попробуй ещё раз")
        }
    }

    // Continuity gave only black placeholder frames: the stream never really started.
    func looksBlocked(after frames: Int = 1) -> Bool {
        guard kind == "iphone", let device, isContinuity(device) else { return false }
        return queue.sync { framesSeen >= frames && brightFrames == 0 }
    }

    func countdown(_ n: Int) {
        guard !done else { return }
        if n <= 0 { left = nil; shoot(); return }
        left = n
        updateOverlay()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.countdown(n - 1) }
    }

    func startCapture(_ d: AVCaptureDevice) {
        showWindow(d.localizedName)
        attach(d)
        keepOverlayFresh()
    }

    // Video size is known only once frames flow.
    func keepOverlayFresh() {
        Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.updateOverlay() }
    }

    func pickBiggestPhotoFormat() {
        guard #available(macOS 13.0, *), let device else { return }
        let area = { (d: CMVideoDimensions?) in Int(d?.width ?? 0) * Int(d?.height ?? 0) }
        let best = device.formats.max {
            area($0.supportedMaxPhotoDimensions.last) < area($1.supportedMaxPhotoDimensions.last)
        }
        if let best, (try? device.lockForConfiguration()) != nil {
            device.activeFormat = best
            device.unlockForConfiguration()
        }
        syncPhotoDimensions()
    }

    // Output and settings must name a size the active format supports.
    func syncPhotoDimensions() {
        guard #available(macOS 13.0, *), let device else { return }
        let dims = device.activeFormat.supportedMaxPhotoDimensions
        let cur = photo.maxPhotoDimensions
        let ok = dims.contains { $0.width == cur.width && $0.height == cur.height }
        if !ok, let big = dims.max(by: { Int($0.width) * Int($0.height) < Int($1.width) * Int($1.height) }) {
            photo.maxPhotoDimensions = big
        }
    }

    // Dim everything outside the centred capture rect.
    func updateOverlay() {
        guard let preview else { return }
        let video = preview.layerRectConverted(fromMetadataOutputRect: CGRect(x: 0, y: 0, width: 1, height: 1))
        CATransaction.begin(); CATransaction.setDisableActions(true)
        if device != nil, video.width > 0 {
            let inner = centreCrop(video, zoom)
            let p = CGMutablePath()
            p.addRect(preview.bounds)
            p.addRect(inner)
            shade.frame = preview.bounds
            shade.path = p
            frameLine.frame = preview.bounds
            frameLine.path = CGPath(roundedRect: inner, cornerWidth: 8, cornerHeight: 8, transform: nil)
        } else {
            shade.path = nil
            frameLine.path = nil
        }
        CATransaction.commit()
        if done { return }
        if let left {
            window.title = String(format: "Claude снимает через %d…  ·  Зум %.1f×  ·  Esc — отмена", left, zoom)
        } else if autoDelay == nil {
            window.title = String(format: "Зум %.1f× (+/−)  ·  Пробел, Enter или «Снять» — снимок, Esc — отмена", zoom)
        } else {
            window.title = "Claude готовит снимок…  ·  Esc — отмена"
        }
    }

    // Zoom is remembered per camera at once.
    func changeZoom(_ step: CGFloat) {
        zooms[kind] = min(max((zoom + step) * 10, 10), 30).rounded() / 10
        storeZoom(kind, zoom)
        updateOverlay()
    }

    @objc func minusPressed() { changeZoom(-0.1) }
    @objc func plusPressed() { changeZoom(0.1) }

    @objc func flashChanged(_ s: NSSegmentedControl) {
        flash = flashModes[s.selectedSegment]
        try? FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
        try? flash.write(toFile: flashPath, atomically: true, encoding: .utf8)
    }

    func showWindow(_ name: String) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 520),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.level = .floating
        window.delegate = self
        let view = KeyView()
        view.onKey = { [weak self] code in
            switch code {
            case 53: finish(1, "Отменено")
            case 24, 69: self?.changeZoom(0.1)
            case 27, 78: self?.changeZoom(-0.1)
            case 49, 36, 76: self?.shoot()
            default: break
            }
        }
        view.onLayout = { [weak self] in self?.updateOverlay() }
        view.wantsLayer = true
        preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspect
        preview.frame = view.bounds
        preview.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        view.layer?.addSublayer(preview)
        shade.fillRule = .evenOdd
        shade.fillColor = NSColor.black.withAlphaComponent(0.55).cgColor
        frameLine.fillColor = nil
        frameLine.strokeColor = NSColor.white.cgColor
        frameLine.lineWidth = 2
        preview.addSublayer(shade)
        preview.addSublayer(frameLine)
        var buttons: [NSControl] = [
            NSButton(title: "−", target: self, action: #selector(minusPressed)),
            NSButton(title: "+", target: self, action: #selector(plusPressed)),
            NSButton(title: "Снять", target: self, action: #selector(shootPressed)),
        ]
        // Only the iPhone has a flash; Desk View frames come from video.
        if kind == "iphone" {
            let seg = NSSegmentedControl(labels: ["⚡︎ выкл", "вкл", "авто"], trackingMode: .selectOne,
                                         target: self, action: #selector(flashChanged(_:)))
            seg.selectedSegment = flashModes.firstIndex(of: flash) ?? 0
            buttons.insert(seg, at: 0)
        }
        buttons.forEach { $0.refusesFirstResponder = true }
        let bar = NSStackView(views: buttons)
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)
        NSLayoutConstraint.activate([
            bar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            bar.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -12),
        ])
        window.contentView = view
        window.title = name
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func shootPressed() { shoot() }

    func shoot() {
        guard !done else { return }
        done = true
        window.title = "Снимаю…"
        // Fewer black frames may be a slow start, not a block.
        if looksBlocked(after: 20) { fail(9, continuityBlocked) }
        step = "снимок"
        if usePhoto {
            guard let c = photo.connection(with: .video), c.isActive, c.isEnabled, session.isRunning else {
                fail(7, "Камера отключилась — нажми ещё раз")
            }
            syncPhotoDimensions()
            let jpeg = photo.availablePhotoCodecTypes.contains(.jpeg)
            let settings = jpeg ? AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg]) : AVCapturePhotoSettings()
            if #available(macOS 13.0, *) { settings.maxPhotoDimensions = photo.maxPhotoDimensions }
            let fm: AVCaptureDevice.FlashMode = flash == "on" ? .on : flash == "auto" ? .auto : .off
            if photo.supportedFlashModes.contains(fm) { settings.flashMode = fm; sentFlash = flash }
            photo.capturePhoto(with: settings, delegate: self)
        } else {
            queue.async { self.wantFrame = true }
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto p: AVCapturePhoto, error: Error?) {
        guard let data = p.fileDataRepresentation() else {
            if error != nil, looksBlocked() { fail(4, continuityBlocked, error) }
            fail(4, "Снимок не получился: \(error?.localizedDescription ?? "нет данных")", error)
        }
        step = "сохранение"
        guard saveJPEG(data, zoom: zoom) else { fail(4, "Снимок не сохранился в \(outPath)") }
        try? "flash requested=\(flash) sent=\(sentFlash)".write(toFile: "\(stateDir)/last-shot.txt", atomically: true, encoding: .utf8)
        finish(0, outPath)
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let px = CMSampleBufferGetImageBuffer(buffer) else { return }
        framesSeen += 1
        if brightFrames == 0, framesSeen % 5 == 1, !isBlack(px) { brightFrames += 1 }
        guard wantFrame else { return }
        wantFrame = false
        step = "сохранение"
        let ci = CIImage(cvPixelBuffer: px)
        guard let cg = CIContext().createCGImage(ci, from: centreCrop(ci.extent, zoom)), writeJPEG(capped(cg)) else {
            fail(4, "Кадр не сохранился")
        }
        finish(0, outPath)
    }

    func windowWillClose(_ notification: Notification) { finish(1, "Отменено") }
}

// Samples an 8×8 grid of a BGRA frame; the disabled-stream placeholder is all zeros.
func isBlack(_ px: CVPixelBuffer) -> Bool {
    guard CVPixelBufferGetPixelFormatType(px) == kCVPixelFormatType_32BGRA else { return false }
    CVPixelBufferLockBaseAddress(px, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(px) else { return false }
    let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px), row = CVPixelBufferGetBytesPerRow(px)
    let bytes = base.assumingMemoryBound(to: UInt8.self)
    for y in 0..<8 {
        for x in 0..<8 {
            let o = (h * (2 * y + 1) / 16) * row + (w * (2 * x + 1) / 16) * 4
            if max(bytes[o], bytes[o + 1], bytes[o + 2]) > 6 { return false }
        }
    }
    return true
}

final class KeyView: NSView {
    var onKey: ((UInt16) -> Void)?
    var onLayout: (() -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override func layout() { super.layout(); onLayout?() }
    override func keyDown(with event: NSEvent) { onKey?(event.keyCode) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let snapper = Snapper()

DispatchQueue.main.asyncAfter(deadline: .now() + 600) { finish(5, "Тайм-аут") }

AVCaptureDevice.requestAccess(for: .video) { ok in
    guard ok else { finish(6, "Нет доступа к камере: Системные настройки → Конфиденциальность → Камера → SnapCam") }
    if mode == "list" {
        // Wait briefly: a wireless iPhone shows up late.
        for _ in 0..<16 where pick("iphone", allDevices()) == nil { Thread.sleep(forTimeInterval: 0.5) }
        let lines = allDevices().map { d in
            "\(d.localizedName) — \(d.deviceType.rawValue): фокус в точке \(d.isFocusPointOfInterestSupported ? "да" : "нет"), "
                + "автофокус \(d.isFocusModeSupported(.autoFocus) ? "да" : "нет"), "
                + "непрерывный \(d.isFocusModeSupported(.continuousAutoFocus) ? "да" : "нет"), "
                + "фиксированный \(d.isFocusModeSupported(.locked) ? "да" : "нет"), "
                + "фонарик \(d.hasTorch && d.isTorchModeSupported(.on) ? "да" : "нет"), "
                + "вспышка \(d.hasFlash ? "да" : "нет")"
        }
        var flashLine = "iPhone: вывод фото не открылся"
        if let d = pick("iphone", allDevices()), let input = try? AVCaptureDeviceInput(device: d) {
            let s = AVCaptureSession(), out = AVCapturePhotoOutput()
            s.sessionPreset = .photo
            if s.canAddInput(input) { s.addInput(input) }
            if s.canAddOutput(out) { s.addOutput(out) }
            s.startRunning()
            Thread.sleep(forTimeInterval: 1.5)
            let names = { out.supportedFlashModes.map { $0 == .on ? "on" : $0 == .auto ? "auto" : "off" }.joined(separator: ", ") }
            flashLine = "iPhone: режимы вспышки у вывода фото — \(names())"
            if #available(macOS 13.0, *) {
                let area = { (x: CMVideoDimensions?) in Int(x?.width ?? 0) * Int(x?.height ?? 0) }
                if let best = d.formats.max(by: { area($0.supportedMaxPhotoDimensions.last) < area($1.supportedMaxPhotoDimensions.last) }),
                   (try? d.lockForConfiguration()) != nil {
                    d.activeFormat = best
                    d.unlockForConfiguration()
                    Thread.sleep(forTimeInterval: 1)
                    flashLine += "; после смены формата — \(names())"
                }
            }
            s.stopRunning()
        }
        finish(0, (lines + [flashLine]).joined(separator: "\n"))
    }
    // Wireless iPhone can take 10-20 s to reconnect.
    let kind = mode == "desk" ? "desk" : "iphone"
    var tries = 0
    var hint: NSWindow?
    func look() {
        if let d = pick(kind, allDevices()) {
            DispatchQueue.main.async { hint?.orderOut(nil); snapper.startCapture(d) }
            return
        }
        tries += 1
        if tries == 2 {
            DispatchQueue.main.async {
                let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 70),
                                 styleMask: [.titled], backing: .buffered, defer: false)
                w.title = "SnapCam"
                w.level = .floating
                let t = NSTextField(labelWithString: "Ищу iPhone… Заблокируй экран и держи телефон рядом с Mac.")
                t.frame = NSRect(x: 16, y: 24, width: 390, height: 22)
                w.contentView?.addSubview(t)
                w.center()
                w.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                hint = w
            }
        }
        if tries > 60 {
            let names = allDevices().map(\.localizedName).joined(separator: ", ")
            finish(2, "Камера «\(kind)» не найдена. Видны: \(names.isEmpty ? "ничего" : names)")
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5, execute: look)
    }
    look()
}

app.run()
