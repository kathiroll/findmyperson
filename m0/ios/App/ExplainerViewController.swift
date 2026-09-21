import UIKit

/// The in-app explanation shown BEFORE each system permission prompt (and before sending the
/// user to Settings). iOS lets an app show the location prompt once per step, so we first say
/// in plain words why we are about to ask.
final class ExplainerViewController: UIViewController {
    private let titleText: String
    private let bodyText: String
    private let continueTitle: String
    private let onContinue: () -> Void

    init(title: String, body: String, continueTitle: String, onContinue: @escaping () -> Void) {
        self.titleText = title; self.bodyText = body
        self.continueTitle = continueTitle; self.onContinue = onContinue
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let title = UILabel()
        title.text = titleText
        title.font = .preferredFont(forTextStyle: .title2)
        title.numberOfLines = 0

        let body = UILabel()
        body.text = bodyText
        body.font = .preferredFont(forTextStyle: .body)
        body.numberOfLines = 0

        let go = UIButton(type: .system)
        go.setTitle(continueTitle, for: .normal)
        go.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        go.addTarget(self, action: #selector(goTapped), for: .touchUpInside)

        let later = UIButton(type: .system)
        later.setTitle("Not now", for: .normal)
        later.addTarget(self, action: #selector(laterTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [title, body, go, later])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    @objc private func goTapped() { dismiss(animated: true) { self.onContinue() } }
    @objc private func laterTapped() { dismiss(animated: true) }
}
