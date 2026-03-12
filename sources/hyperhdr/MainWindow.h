#pragma once

#include <QMainWindow>
#include <QWebEngineView>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineSettings>
#include <QWebEngineCookieStore>
#include <QWebEngineNewWindowRequest>
#include <QWebEngineFullScreenRequest>
#include <QCloseEvent>
#include <QShowEvent>
#include <QHideEvent>
#include <QDesktopServices>
#include <QIcon>
#include <QApplication>
#include <QScreen>
#include <QStyle>
#include <QStandardPaths>
#include <QShortcut>
#include <QLabel>

// Custom page: keeps localhost navigation in-app, opens external links in the real browser
class LocalWebPage : public QWebEnginePage
{
	Q_OBJECT
public:
	explicit LocalWebPage(QWebEngineProfile* profile, QWebEngineView* parent = nullptr)
		: QWebEnginePage(profile, parent) {}

protected:
	bool acceptNavigationRequest(const QUrl& url, NavigationType, bool) override
	{
		if (url.host() == "localhost" || url.host() == "127.0.0.1")
			return true;
		QDesktopServices::openUrl(url);
		return false;
	}
};

class MainWindow : public QMainWindow
{
	Q_OBJECT

public:
	// Accepts an optional pre-warmed profile from the caller (e.g. SystrayHandler).
	// If nullptr, creates its own profile on first show — same behaviour as before.
	explicit MainWindow(int port, QWebEngineProfile* profile = nullptr, QWidget* parent = nullptr)
		: QMainWindow(parent)
		, _port(port)
		, _profile(profile)
	{
		setWindowTitle("HyperHDR");
		setWindowIcon(QIcon(":/hyperhdr.png"));
		resize(1280, 800);

		setGeometry(
			QStyle::alignedRect(Qt::LeftToRight, Qt::AlignCenter, size(),
				QApplication::primaryScreen()->availableGeometry())
		);

		_placeholder = new QLabel("Loading HyperHDR...", this);
		_placeholder->setAlignment(Qt::AlignCenter);
		_placeholder->setStyleSheet("background:#1a1a1a; color:#888; font-size:16px;");
		setCentralWidget(_placeholder);

		QShortcut* fullscreenShortcut = new QShortcut(QKeySequence(Qt::Key_F11), this);
		connect(fullscreenShortcut, &QShortcut::activated, this, &MainWindow::toggleFullscreen);

		QShortcut* escShortcut = new QShortcut(QKeySequence(Qt::Key_Escape), this);
		connect(escShortcut, &QShortcut::activated, this, [this]() {
			if (isFullScreen()) showNormal();
		});
	}

	void toggleVisibility()
	{
		if (isVisible()) { hide(); }
		else { show(); raise(); activateWindow(); }
	}

	void toggleFullscreen()
	{
		if (isFullScreen()) showNormal();
		else showFullScreen();
	}

protected:
	void showEvent(QShowEvent* event) override
	{
		QMainWindow::showEvent(event);

		if (_view == nullptr)
			initWebView();
		else
			_view->page()->setLifecycleState(QWebEnginePage::LifecycleState::Active);
	}

	void hideEvent(QHideEvent* event) override
	{
		QMainWindow::hideEvent(event);

		// Freeze: pauses JS, timers, animations, network polling.
		// Page state is fully preserved and resumes instantly on show.
		if (_view != nullptr)
			_view->page()->setLifecycleState(QWebEnginePage::LifecycleState::Frozen);
	}

	void closeEvent(QCloseEvent* event) override
	{
		if (isFullScreen()) showNormal();
		hide();
		event->ignore();
	}

private:
	void initWebView()
	{
		// If no pre-warmed profile was injected, build one now.
		if (_profile == nullptr)
		{
			QString storagePath = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)
				+ "/webprofile";
			_profile = new QWebEngineProfile("hyperhdr", this);
			_profile->setPersistentStoragePath(storagePath);
			_profile->setCachePath(storagePath + "/cache");
			_profile->setPersistentCookiesPolicy(QWebEngineProfile::ForcePersistentCookies);
			_profile->setHttpCacheType(QWebEngineProfile::DiskHttpCache);
			_profile->settings()->setAttribute(QWebEngineSettings::FullScreenSupportEnabled, true);
		}

		_view = new QWebEngineView(this);
		_view->setPage(new LocalWebPage(_profile, _view));

		connect(_view->page(), &QWebEnginePage::newWindowRequested,
			this, [this](QWebEngineNewWindowRequest& req) {
				_view->load(req.requestedUrl());
			});

		connect(_view->page(), &QWebEnginePage::fullScreenRequested,
			this, [this](QWebEngineFullScreenRequest req) {
				req.accept();
				if (req.toggleOn()) showFullScreen();
				else showNormal();
			});

		setCentralWidget(_view);
		_placeholder = nullptr;

		// FIX: Removed the 800 ms singleShot delay. The web server is already
		// bound before this process is ever spawned by UiLauncher, so there is
		// no port-race to protect against. Loading immediately saves ~800 ms
		// of guaranteed dead time on every single startup.
		_view->load(QUrl(QString("http://localhost:%1").arg(_port)));
	}

	QWebEngineView*    _view        = nullptr;
	QWebEngineProfile* _profile     = nullptr;
	QLabel*            _placeholder = nullptr;
	int                _port        = 8090;
};
