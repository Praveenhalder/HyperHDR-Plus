#include <QApplication>
#include <QCommandLineParser>
#include <QLocalServer>
#include <QLocalSocket>
#include <QMainWindow>
#include <QWebEngineView>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineSettings>
#include <QWebEngineNewWindowRequest>
#include <QWebEngineFullScreenRequest>
#include <QCloseEvent>
#include <QMouseEvent>
#include <QTimer>
#include <QDesktopServices>
#include <QIcon>
#include <QScreen>
#include <QStyle>
#include <QStandardPaths>
#include <QShortcut>
#include <QLabel>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QPixmap>
#include <QPalette>
#include <QStackedWidget>
#include <QSplashScreen>
#include <QPainter>
#include <QFile>
#include <QTextStream>
#include <QPushButton>
#include <QWidget>
#include <QWindow>
#include <QHash>

#ifdef _WIN32
#include <windows.h>
#include <shellscalingapi.h>
#pragma comment(lib, "Shcore.lib")
#endif

// ── loadLogo ──────────────────────────────────────────────────────────────────
// Load once, reuse everywhere — avoids double disk I/O + double smooth-scale.

static const QPixmap& cachedLogo()
{
    static QPixmap px = []() -> QPixmap {
        QString logoPath = QCoreApplication::applicationDirPath() + "/logo.jpg";
        QPixmap p(logoPath);
        if (p.isNull())
            p = QPixmap(QCoreApplication::applicationDirPath() + "/logo.png");
        return p;
    }();
    return px;
}

// Returns a scaled pixmap, computing it at most once per targetWidth.
// SmoothTransformation is expensive — caching ensures it never runs twice.
static const QPixmap& logoScaled(int targetWidth)
{
    // One cached entry per width. In practice only 480 is ever requested.
    static QHash<int, QPixmap> cache;
    auto it = cache.find(targetWidth);
    if (it == cache.end())
    {
        const QPixmap& src = cachedLogo();
        it = cache.insert(targetWidth, src.isNull()
            ? QPixmap()
            : src.scaledToWidth(targetWidth, Qt::SmoothTransformation));
    }
    return it.value();
}

// ── TitleBar ──────────────────────────────────────────────────────────────────

class TitleBar : public QWidget
{
    Q_OBJECT
public:
    explicit TitleBar(QWidget* mainWindow, QWidget* parent = nullptr)
        : QWidget(parent)
        , _mainWindow(mainWindow)
    {
        setAttribute(Qt::WA_TranslucentBackground);
        setFixedHeight(36);

        QHBoxLayout* layout = new QHBoxLayout(this);
        layout->setContentsMargins(0, 0, 6, 0);
        layout->setSpacing(2);
        layout->addStretch();

        auto makeBtn = [&](const QString& glyph, int w) -> QPushButton* {
            auto* btn = new QPushButton(glyph, this);
            btn->setFixedSize(w, 22);
            btn->setCursor(Qt::ArrowCursor);
            btn->setFlat(true);
            return btn;
        };

        _btnMin = makeBtn("─", 28);
        _btnMin->setToolTip("Minimize");
        _btnMin->setStyleSheet(R"(
            QPushButton {
                background: transparent; border: none; border-radius: 4px;
                color: rgba(220,220,220,180); font-size: 14px;
            }
            QPushButton:hover   { background: rgba(255,255,255,30); color: white; }
            QPushButton:pressed { background: rgba(255,255,255,15); }
        )");
        connect(_btnMin, &QPushButton::clicked, this, [this]() {
            _mainWindow->showMinimized();
        });

        _btnMax = makeBtn("□", 28);
        _btnMax->setToolTip("Maximize");
        _btnMax->setStyleSheet(R"(
            QPushButton {
                background: transparent; border: none; border-radius: 4px;
                color: rgba(220,220,220,180); font-size: 13px;
            }
            QPushButton:hover   { background: rgba(255,255,255,30); color: white; }
            QPushButton:pressed { background: rgba(255,255,255,15); }
        )");
        connect(_btnMax, &QPushButton::clicked, this, [this]() {
            if (_mainWindow->isMaximized() || _mainWindow->isFullScreen())
            { _mainWindow->showNormal();    _btnMax->setText("□"); _btnMax->setToolTip("Maximize"); }
            else
            { _mainWindow->showMaximized(); _btnMax->setText("❐"); _btnMax->setToolTip("Restore"); }
        });

        _btnClose = makeBtn("✕", 36);
        _btnClose->setToolTip("Close");
        _btnClose->setStyleSheet(R"(
            QPushButton {
                background: transparent; border: none; border-radius: 4px;
                color: rgba(220,220,220,180); font-size: 15px;
            }
            QPushButton:hover   { background: rgba(196,43,28,210); color: white; }
            QPushButton:pressed { background: rgba(196,43,28,140); }
        )");
        connect(_btnClose, &QPushButton::clicked, this, [this]() {
            _mainWindow->close();
        });

        layout->addWidget(_btnMin);
        layout->addWidget(_btnMax);
        layout->addWidget(_btnClose);
    }

    void syncMaxButton()
    {
        if (_mainWindow->isMaximized() || _mainWindow->isFullScreen())
        { _btnMax->setText("❐"); _btnMax->setToolTip("Restore"); }
        else
        { _btnMax->setText("□"); _btnMax->setToolTip("Maximize"); }
    }

protected:
    void mousePressEvent(QMouseEvent* event) override
    {
        if (event->button() == Qt::LeftButton)
        {
            QWidget* child = childAt(event->pos());
            if (child && (child == _btnMin || child == _btnMax || child == _btnClose))
            { QWidget::mousePressEvent(event); return; }

            if (_mainWindow->windowHandle())
                _mainWindow->windowHandle()->startSystemMove();

            event->accept();
        }
    }

    void mouseMoveEvent(QMouseEvent* event) override   { QWidget::mouseMoveEvent(event); }
    void mouseReleaseEvent(QMouseEvent* event) override { QWidget::mouseReleaseEvent(event); }

    void mouseDoubleClickEvent(QMouseEvent* event) override
    {
        if (event->button() == Qt::LeftButton)
        {
            QWidget* child = childAt(event->pos());
            if (!child || (child != _btnMin && child != _btnMax && child != _btnClose))
            {
                if (_mainWindow->isMaximized())
                { _mainWindow->showNormal();    syncMaxButton(); }
                else
                { _mainWindow->showMaximized(); syncMaxButton(); }
            }
        }
        QWidget::mouseDoubleClickEvent(event);
    }

private:
    QWidget*     _mainWindow  = nullptr;
    QPushButton* _btnMin      = nullptr;
    QPushButton* _btnMax      = nullptr;
    QPushButton* _btnClose    = nullptr;
};

// ── LocalWebPage ──────────────────────────────────────────────────────────────

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

// ── MainWindow ────────────────────────────────────────────────────────────────

class MainWindow : public QMainWindow
{
    Q_OBJECT

signals:
    void pageReady();

public:
    explicit MainWindow(int port, QWebEngineProfile* profile, bool keepLoaded = false, QWidget* parent = nullptr)
        : QMainWindow(parent)
        , _port(port)
        , _profile(profile)
        , _keepLoaded(keepLoaded)
    {
        setWindowFlags(Qt::FramelessWindowHint | Qt::Window);
        setAttribute(Qt::WA_TranslucentBackground, false);
        setAttribute(Qt::WA_NoSystemBackground, false);
        setStyleSheet("MainWindow { background: #1a1a1a; }");

        setWindowTitle("HyperHDR");
        setWindowIcon(QIcon(":/hyperhdr.png"));
        resize(1280, 800);
        setGeometry(QStyle::alignedRect(Qt::LeftToRight, Qt::AlignCenter,
            size(), QApplication::primaryScreen()->availableGeometry()));

        _stack = new QStackedWidget(this);
        _stack->setStyleSheet("QStackedWidget { background: #1a1a1a; }");
        setCentralWidget(_stack);

        // ── Page 0: loading screen ────────────────────────────────────────────
        // The splash screen already covers the window during Chromium init,
        // so this page is only visible for a fraction of a second (if at all).
        // Use the lightest possible widget — no logo decode, no layout, no label.
        QWidget* loadPage = new QWidget();
        loadPage->setStyleSheet("background-color: #1a1a1a;");
        _stack->addWidget(loadPage);    // index 0

        // ── Page 1: web container ─────────────────────────────────────────────
        _webContainer = new QWidget();
        _webContainer->setStyleSheet("background: #1a1a1a;");

        QVBoxLayout* webLayout = new QVBoxLayout(_webContainer);
        webLayout->setContentsMargins(0, 0, 0, 0);
        webLayout->setSpacing(0);

        _view = new QWebEngineView(_webContainer);
        _view->setPage(new LocalWebPage(_profile, _view));
        webLayout->addWidget(_view);

        _stack->addWidget(_webContainer);   // index 1

        _titleBar = new TitleBar(this, _stack);
        _titleBar->hide();
        _titleBar->raise();
        _titleBar->setGeometry(0, 0, _stack->width(), 36);

        connect(_view->page(), &QWebEnginePage::newWindowRequested,
            this, [this](QWebEngineNewWindowRequest& req) {
                _view->load(req.requestedUrl());
            });

        connect(_view->page(), &QWebEnginePage::fullScreenRequested,
            this, [this](QWebEngineFullScreenRequest req) {
                req.accept();
                if (req.toggleOn()) { showFullScreen();  _titleBar->hide(); }
                else                { showNormal();       _titleBar->show(); _titleBar->syncMaxButton(); }
            });

        // FIX 3: Switch to the web view as soon as the first paint lands
        // (loadStarted fires before loadFinished — gives much earlier feedback).
        // We still emit pageReady on loadFinished so the splash can close cleanly.
        connect(_view, &QWebEngineView::loadStarted, this, [this]() {
            // The page is being fetched; swap from loading screen to webview
            // so the user sees the page render incrementally rather than waiting
            // for 100% load before anything appears.
            _stack->setCurrentIndex(1);
            _titleBar->setGeometry(0, 0, _stack->width(), 36);
            _titleBar->show();
            _titleBar->raise();
        });

        connect(_view, &QWebEngineView::loadFinished, this, [this](bool) {
            // Guarantee correct state even if loadStarted was missed.
            _stack->setCurrentIndex(1);
            _titleBar->setGeometry(0, 0, _stack->width(), 36);
            _titleBar->show();
            _titleBar->raise();
            emit pageReady();
        });

        // FIX 4: Load the URL immediately — no singleShot delay.
        // The server is already listening by the time UiLauncher spawns this
        // process; there is no race to protect against.
        _view->load(QUrl(QString("http://localhost:%1").arg(_port)));
        _stack->setCurrentIndex(0);

        auto* f11 = new QShortcut(QKeySequence(Qt::Key_F11), this);
        connect(f11, &QShortcut::activated, this, &MainWindow::toggleFullscreen);

        auto* esc = new QShortcut(QKeySequence(Qt::Key_Escape), this);
        connect(esc, &QShortcut::activated, this, [this]() {
            if (isFullScreen()) { showNormal(); _titleBar->show(); _titleBar->syncMaxButton(); }
        });
    }

    void toggleFullscreen()
    {
        if (isFullScreen()) { showNormal();    _titleBar->show(); _titleBar->syncMaxButton(); }
        else                { showFullScreen(); _titleBar->hide(); }
    }

    // Called via IPC when keep-loaded mode hides the window without killing
    // the process. Freezes the page to save CPU/RAM while hidden.
    void hideToBackground()
    {
        if (isFullScreen()) showNormal();
        if (_view != nullptr)
            _view->page()->setLifecycleState(QWebEnginePage::LifecycleState::Frozen);
        hide();
    }

    // Called via IPC before re-showing the window after a keep-loaded hide.
    void resumeFromBackground()
    {
        if (_view != nullptr)
            _view->page()->setLifecycleState(QWebEnginePage::LifecycleState::Active);
    }

protected:
    void resizeEvent(QResizeEvent* event) override
    {
        QMainWindow::resizeEvent(event);
        if (_titleBar && _stack)
            _titleBar->setGeometry(0, 0, _stack->width(), 36);
    }

    void closeEvent(QCloseEvent* event) override
    {
        if (_keepLoaded)
        {
            // Keep-loaded mode: hide to background instead of quitting.
            // The daemon will kill this process when it shuts down.
            event->ignore();
            hideToBackground();
        }
        else
        {
            // Normal mode: close really means quit.
            if (isFullScreen()) showNormal();
            event->accept();
            QApplication::quit();
        }
    }

    void mousePressEvent(QMouseEvent* event) override
    {
        if (event->button() == Qt::LeftButton)
        {
            Qt::Edges edge = hitTest(event->pos());
            if (edge != Qt::Edges{} && windowHandle())
            {
                windowHandle()->startSystemResize(edge);
                event->accept();
                return;
            }
        }
        QMainWindow::mousePressEvent(event);
    }

    void mouseMoveEvent(QMouseEvent* event) override
    {
        Qt::Edges edge = hitTest(event->pos());
        if      (edge == (Qt::LeftEdge  | Qt::TopEdge)    || edge == (Qt::RightEdge | Qt::BottomEdge)) setCursor(Qt::SizeFDiagCursor);
        else if (edge == (Qt::RightEdge | Qt::TopEdge)    || edge == (Qt::LeftEdge  | Qt::BottomEdge)) setCursor(Qt::SizeBDiagCursor);
        else if (edge & Qt::LeftEdge  || edge & Qt::RightEdge)  setCursor(Qt::SizeHorCursor);
        else if (edge & Qt::TopEdge   || edge & Qt::BottomEdge) setCursor(Qt::SizeVerCursor);
        else unsetCursor();

        QMainWindow::mouseMoveEvent(event);
    }

    void mouseReleaseEvent(QMouseEvent* event) override { QMainWindow::mouseReleaseEvent(event); }

private:
    Qt::Edges hitTest(const QPoint& pos) const
    {
        const int m = 6;
        Qt::Edges e;
        if (pos.x() <= m)              e |= Qt::LeftEdge;
        if (pos.x() >= width()  - m)   e |= Qt::RightEdge;
        if (pos.y() <= m)              e |= Qt::TopEdge;
        if (pos.y() >= height() - m)   e |= Qt::BottomEdge;
        return e;
    }

    QStackedWidget*    _stack          = nullptr;
    QWidget*           _webContainer   = nullptr;
    QWebEngineView*    _view           = nullptr;
    QWebEngineProfile* _profile        = nullptr;
    TitleBar*          _titleBar       = nullptr;
    int                _port           = 8090;
    bool               _keepLoaded     = false;
};

// ── main ──────────────────────────────────────────────────────────────────────

#include "hyperhdr-ui-main.moc"

int main(int argc, char** argv)
{
#ifdef _WIN32
    SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
#endif

    QApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
    QApplication::setAttribute(Qt::AA_UseHighDpiPixmaps);

    // Chromium GPU + process flags.
    // --process-per-site           → one renderer per origin, cuts spawn overhead.
    // --disable-back-forward-cache → no BFCache allocs on first load (never navigate back).
    // --disable-features=...       → skip memory-pressure GC mid-load.
    // --renderer-process-limit=1   → cap at one renderer; we only ever show one page.
    // --disable-extensions         → no extension scanning on startup.
    // --no-sandbox (omitted intentionally — keep security) 
    // --disable-logging            → suppress Chromium's internal log writes to disk.
    // --log-level=3                → only fatal errors; quiets noisy startup output.
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS",
        "--use-angle=d3d11 "
        "--disable-gpu-vsync "
        "--enable-zero-copy "
        "--disable-software-rasterizer "
        "--num-raster-threads=4 "
        "--process-per-site "
        "--disable-back-forward-cache "
        "--renderer-process-limit=1 "
        "--disable-extensions "
        "--disable-logging "
        "--log-level=3 "
        "--disable-features=MemoryPressureBasedSourceBufferGC");

    QApplication::setStyle("fusion");

    QApplication app(argc, argv);
    QApplication::setApplicationName("HyperHdr");
    QApplication::addLibraryPath(QApplication::applicationDirPath() + "/../lib");

    QPalette darkPalette;
    darkPalette.setColor(QPalette::All, QPalette::Window,     QColor("#1a1a1a"));
    darkPalette.setColor(QPalette::All, QPalette::Base,       QColor("#1a1a1a"));
    darkPalette.setColor(QPalette::All, QPalette::WindowText, Qt::white);
    darkPalette.setColor(QPalette::All, QPalette::Text,       Qt::white);
    app.setPalette(darkPalette);

    QCommandLineParser parser;
    QCommandLineOption portOption("port", "Web server port", "port", "8090");
    QCommandLineOption hiddenOption("hidden", "Start with window hidden (used by keep-loaded mode)");
    QCommandLineOption keepLoadedOption("keep-loaded", "Hide window on close instead of quitting");
    parser.addOption(portOption);
    parser.addOption(hiddenOption);
    parser.addOption(keepLoadedOption);
    parser.process(app);

    int port = parser.value(portOption).toInt();
    if (port <= 0) port = 8090;
    const bool startHidden  = parser.isSet(hiddenOption);
    const bool keepLoaded   = parser.isSet(keepLoadedOption);

    // Skip the splash entirely when starting hidden — no point showing it
    // if the window will never appear on this launch.
    QSplashScreen* splash = nullptr;
    if (!startHidden)
    {
        const QPixmap& scaled480 = logoScaled(480);
        if (!scaled480.isNull())
        {
            QPixmap bg(600, 300);
            bg.fill(QColor("#1a1a1a"));
            QPainter painter(&bg);
            painter.drawPixmap((bg.width() - scaled480.width()) / 2,
                               (bg.height() - scaled480.height()) / 2, scaled480);
            painter.end();

            splash = new QSplashScreen(bg, Qt::WindowStaysOnTopHint | Qt::FramelessWindowHint);
            splash->show();
        }
    }

    // PRE-WARM: Create the WebEngine profile here, before MainWindow, so
    // Chromium's browser process starts while the splash screen is visible.
    // MainWindow receives the already-warm profile instead of paying that
    // startup cost itself — shaves ~150-300 ms off perceived load time.
    QString storagePath = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)
        + "/webprofile";
    QWebEngineProfile* profile = new QWebEngineProfile("hyperhdr", &app);
    profile->setPersistentStoragePath(storagePath);
    profile->setCachePath(storagePath + "/cache");
    profile->setPersistentCookiesPolicy(QWebEngineProfile::ForcePersistentCookies);
    profile->setHttpCacheType(QWebEngineProfile::DiskHttpCache);
    profile->settings()->setAttribute(QWebEngineSettings::FullScreenSupportEnabled, true);

    // PRE-WARM RENDERER: Loading about:blank on a throw-away page forces
    // Chromium to spawn its renderer subprocess now, while the splash is shown.
    // When MainWindow later calls load(localhost), the renderer is already up
    // and the navigation completes ~100-200 ms faster.
    {
        auto* warmPage = new QWebEnginePage(profile, &app);
        warmPage->load(QUrl("about:blank"));
        // Destroyed after first load — frees the page but keeps the renderer alive
        // because the profile still holds a reference to the render process.
        QObject::connect(warmPage, &QWebEnginePage::loadFinished,
            warmPage, &QObject::deleteLater);
    }

    QLocalServer::removeServer("hyperhdr-show-window-ui");
    QLocalServer server;
    server.listen("hyperhdr-show-window-ui");

    MainWindow window(port, profile, keepLoaded);

    QObject::connect(&window, &MainWindow::pageReady, [&]() {
        if (splash) { splash->finish(&window); delete splash; splash = nullptr; }
        if (!startHidden)
        {
            window.show();
            window.raise();
            window.activateWindow();
        }
    });

    // Show immediately (no splash) only if not hidden and no logo was found.
    if (!startHidden && !splash) window.show();

    QObject::connect(&server, &QLocalServer::newConnection, &window,
        [&server, &window]() {
            QLocalSocket* socket = server.nextPendingConnection();
            QObject::connect(socket, &QLocalSocket::readyRead, &window,
                [socket, &window]() {
                    QByteArray cmd = socket->readAll();
                    if (cmd.contains("show"))
                    {
                        window.resumeFromBackground();
                        window.show();
                        window.raise();
                        window.activateWindow();
                    }
                    else if (cmd.contains("hide"))
                    {
                        // Keep-loaded hide: freeze page and hide window,
                        // but keep the process alive.
                        window.hideToBackground();
                    }
                    else if (cmd.contains("quit"))
                    {
                        // Daemon is shutting down — exit for real.
                        QApplication::quit();
                    }
                    socket->deleteLater();
                });
        });

    return app.exec();
}
