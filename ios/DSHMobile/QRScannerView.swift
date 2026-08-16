import SwiftUI
import AVFoundation

/// 二维码扫描（AVFoundation）
struct QRScannerView: UIViewControllerRepresentable {
    var onScan: (URL) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onScan = onScan
        return controller
    }

    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onScan: ((URL) -> Void)?
        private var session: AVCaptureSession?
        private var deniedLabel: UILabel?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                start()
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                    DispatchQueue.main.async {
                        granted ? self?.start() : self?.showDenied()
                    }
                }
            default:
                showDenied()
            }
        }

        private func start() {
            let session = AVCaptureSession()
            session.sessionPreset = .high
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device) else {
                showDenied(); return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.frame = view.bounds
            preview.videoGravity = .resizeAspectFill
            view.layer.addSublayer(preview)

            // 扫码框提示
            let frame = UIView()
            frame.layer.borderColor = UIColor.cyan.cgColor
            frame.layer.borderWidth = 2
            frame.layer.cornerRadius = 12
            frame.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(frame)
            NSLayoutConstraint.activate([
                frame.widthAnchor.constraint(equalToConstant: 240),
                frame.heightAnchor.constraint(equalToConstant: 240),
                frame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                frame.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            ])

            let hint = UILabel()
            hint.text = "对准 Mac 上 DSH Desktop 的局域网二维码"
            hint.textColor = .white
            hint.font = .systemFont(ofSize: 14)
            hint.textAlignment = .center
            hint.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(hint)
            NSLayoutConstraint.activate([
                hint.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                hint.topAnchor.constraint(equalTo: frame.bottomAnchor, constant: 16),
            ])

            session.startRunning()
            self.session = session
        }

        private func showDenied() {
            let label = UILabel()
            label.text = "需要相机权限才能扫码。\n请在 设置 → 隐私与安全性 → 相机 中允许 DSH Mobile。"
            label.textColor = .white
            label.numberOfLines = 0
            label.textAlignment = .center
            label.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
                label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
                label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
            ])
            deniedLabel = label
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let string = object.stringValue,
                  let url = URL(string: string) else { return }
            session?.stopRunning()
            onScan?(url)
        }
    }
}
