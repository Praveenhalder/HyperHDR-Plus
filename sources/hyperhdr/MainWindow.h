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
#include <QTimer>
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
	explicit MainWindow(int port, QWidget* parent = nullptr)
		: QMainWindow(parent)
		, _port(port)
	{
		setWindowTitle("HyperHDR");
		setWindowIcon(QIcon(":/hyperhdr.png"));
		resize(1280, 800);

		// Center on primary screen
		setGeometry(
			QStyle::alignedRect(Qt::LeftToRight, Qt::AlignCenter, size(),
				QApplication::primaryScreen()->availableGeometry())
		);

		// Placeholder shown before Chromium loads — zero RAM cost
		_placeholder = new QLabel("Loading HyperHDR...", this);
		_placeholder->setAlignment(Qt::AlignCenter);
		_placeholder->setStyleSheet("background:#1a1a1a; color:#888; font-size:16px;");
		setCentralWidget(_placeholder);

		// F11 toggles fullscreen
		QShortcut* fullscreenShortcut = new QShortcut(QKeySequence(Qt::Key_F11), this);
		connect(fullscreenShortcut, &QShortcut::activated, this, &MainWindow::toggleFullscreen);

		// Escape exits fullscreen
		QShortcut* escShortcut = new QShortcut(QKeySequence(Qt::Key_Escape), this);
		connect(escShortcut, &QShortcut::activated, this, [this]() {
			if (isFullScreen())
				showNormal();
		});
	}

	void toggleVisibility()
	{
		if (isVisible())
		{
			hide();
		}
		else
		{
			show();
			raise();
			activateWindow();
		}
	}

	void toggleFullscreen()
	{
		if (isFullScreen())
			showNormal();
		else
			showFullScreen();
	}

protected:
	void showEvent(QShowEvent* event) override
	{
		QMainWindow::showEvent(event);

		if (_view == nullptr)
		{
			// First ever show — lazy init Chromium
			initWebView();
		}
		else
		{
			// Resume from Frozen — page state is fully preserved
			_view->page()->setLifecycleState(QWebEnginePage::LifecycleState::Active);
		}
	}

	void hideEvent(QHideEvent* event) override
	{
		QMainWindow::hideEvent(event);

		// Freeze the page when hidden — pauses timers, animations, network
		// polling, JS execution. Page state is fully preserved in memory so
		// it resumes exactly where it left off when shown again.
		if (_view != nullptr)
			_view->page()->setLifecycleState(QWebEnginePage::LifecycleState::Frozen);
	}

	void closeEvent(QCloseEvent* event) override
	{
		if (isFullScreen())
			showNormal();
		hide();
		event->ignore();
	}

private:
	void initWebView()
	{
		// Persistent profile — stores cookies, localStorage, cache on disk
		QString storagePath = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)
			+ "/webprofile";

		_profile = new QWebEngineProfile("hyperhdr", this);
		_profile->setPersistentStoragePath(storagePath);
		_profile->setCachePath(storagePath + "/cache");
		_profile->setPersistentCookiesPolicy(QWebEngineProfile::ForcePersistentCookies);
		_profile->setHttpCacheType(QWebEngineProfile::DiskHttpCache);

		// Allow the web UI to use the Fullscreen API (element.requestFullscreen())
		_profile->settings()->setAttribute(QWebEngineSettings::FullScreenSupportEnabled, true);

		_view = new QWebEngineView(this);

		// Custom page uses persistent profile
		auto* page = new LocalWebPage(_profile, _view);
		_view->setPage(page);

		// Keep new tab/window requests inside the same view
		connect(_view->page(), &QWebEnginePage::newWindowRequested,
			this, [this](QWebEngineNewWindowRequest& req) {
				_view->load(req.requestedUrl());
			});

		// Accept fullscreen requests from the web page
		connect(_view->page(), &QWebEnginePage::fullScreenRequested,
			this, [this](QWebEngineFullScreenRequest req) {
				req.accept();
				if (req.toggleOn())
					showFullScreen();
				else
					showNormal();
			});

		// Swap out placeholder for the real view
		setCentralWidget(_view);
		_placeholder = nullptr; // deleted automatically by Qt when replaced

		// Small delay so the web server has time to bind its port
		QTimer::singleShot(800, this, [this]() {
			_view->load(QUrl(QString("http://localhost:%1").arg(_port)));
		});
	}

	QWebEngineView*    _view        = nullptr;
	QWebEngineProfile* _profile     = nullptr;
	QLabel*            _placeholder = nullptr;
	int                _port        = 8090;
};
