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
#include <QTimer>
#include <QDesktopServices>
#include <QIcon>
#include <QScreen>
#include <QStyle>
#include <QStandardPaths>
#include <QShortcut>
#include <QLabel>
#include <QVBoxLayout>
#include <QPixmap>
#include <QPalette>
#include <QStackedWidget>
#include <QSplashScreen>
#include <QPainter>
#include <QFile>
#include <QTextStream>

#ifdef _WIN32
#include <windows.h>
#include <shellscalingapi.h>
#pragma comment(lib, "Shcore.lib")
#endif

// ── Embedded logo ─────────────────────────────────────────────────────────────

static QPixmap loadLogo()
{
    // Load logo from same directory as the executable
    QString logoPath = QCoreApplication::applicationDirPath() + "/logo.jpg";
    QPixmap px(logoPath);
    if (px.isNull())
    {
        // Try png as fallback
        px = QPixmap(QCoreApplication::applicationDirPath() + "/logo.png");
    }
    return px;
}

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
    explicit MainWindow(int port, QWidget* parent = nullptr)
        : QMainWindow(parent)
        , _port(port)
        , _storagePath(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/webprofile")
    {
        setWindowTitle("HyperHDR");
        setWindowIcon(QIcon(":/hyperhdr.png"));
        resize(1280, 800);
        setGeometry(QStyle::alignedRect(Qt::LeftToRight, Qt::AlignCenter,
            size(), QApplication::primaryScreen()->availableGeometry()));

        // Use a stacked widget — page 0 = loading screen, page 1 = webview
        // Swapping pages is instant with no resize flash
        _stack = new QStackedWidget(this);
        setCentralWidget(_stack);

        // Page 0: loading screen
        QWidget* loadPage = new QWidget();
        loadPage->setStyleSheet("background-color: #1a1a1a;");
        QVBoxLayout* layout = new QVBoxLayout(loadPage);
        layout->setAlignment(Qt::AlignCenter);
        QLabel* logo = new QLabel();
        QPixmap px = loadLogo();
        if (!px.isNull())
            logo->setPixmap(px.scaledToWidth(480, Qt::SmoothTransformation));
        else
            logo->setText("HyperHDR");
        logo->setAlignment(Qt::AlignCenter);
        layout->addWidget(logo);
        _stack->addWidget(loadPage);  // index 0

        // Page 1: webview — created now so it starts loading in background
        _profile = new QWebEngineProfile("hyperhdr", this);
        _profile->setPersistentStoragePath(_storagePath);
        _profile->setCachePath(_storagePath + "/cache");
        _profile->setPersistentCookiesPolicy(QWebEngineProfile::ForcePersistentCookies);
        _profile->setHttpCacheType(QWebEngineProfile::DiskHttpCache);
        _profile->settings()->setAttribute(QWebEngineSettings::FullScreenSupportEnabled, true);

        _view = new QWebEngineView();
        _view->setPage(new LocalWebPage(_profile, _view));
        _stack->addWidget(_view);     // index 1

        connect(_view->page(), &QWebEnginePage::newWindowRequested,
            this, [this](QWebEngineNewWindowRequest& req) {
                _view->load(req.requestedUrl());
            });

        connect(_view->page(), &QWebEnginePage::fullScreenRequested,
            this, [this](QWebEngineFullScreenRequest req) {
                req.accept();
                req.toggleOn() ? showFullScreen() : showNormal();
            });

        // Switch to webview and signal ready when page loads
        connect(_view, &QWebEngineView::loadFinished, this, [this](bool ok) {
            Q_UNUSED(ok)
            _stack->setCurrentIndex(1);
            emit pageReady();
        });

        // Start loading — server is already running
        _view->load(QUrl(QString("http://localhost:%1").arg(_port)));

        // Show loading screen first
        _stack->setCurrentIndex(0);

        auto* f11 = new QShortcut(QKeySequence(Qt::Key_F11), this);
        connect(f11, &QShortcut::activated, this, &MainWindow::toggleFullscreen);

        auto* esc = new QShortcut(QKeySequence(Qt::Key_Escape), this);
        connect(esc, &QShortcut::activated, this, [this]() {
            if (isFullScreen()) showNormal();
        });
    }

    void toggleFullscreen()
    {
        isFullScreen() ? showNormal() : showFullScreen();
    }

protected:
    void closeEvent(QCloseEvent* event) override
    {
        if (isFullScreen()) showNormal();
        event->accept();
        QApplication::quit();
    }

private:
    QStackedWidget*    _stack   = nullptr;
    QWebEngineView*    _view    = nullptr;
    QWebEngineProfile* _profile = nullptr;
    int                _port    = 8090;
    QString            _storagePath;
};

// ── main ──────────────────────────────────────────────────────────────────────

#include "hyperhdr-ui-main.moc"

int main(int argc, char** argv)
{
#ifdef _WIN32
    SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
#endif

    qputenv("QT_LOGGING_RULES", "qt.webenginecontext.debug=true");
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS", "--enable-logging --log-level=0");

    // Must set fusion style BEFORE QApplication to prevent white flash
    QApplication::setStyle("fusion");
    QApplication::setAttribute(Qt::AA_UseHighDpiPixmaps);

    QApplication app(argc, argv);
    QApplication::setApplicationName("HyperHdr");
    QApplication::addLibraryPath(QApplication::applicationDirPath() + "/../lib");

    // Dark palette kills the white background before any window paints
    QPalette darkPalette;
    darkPalette.setColor(QPalette::All, QPalette::Window,      QColor("#1a1a1a"));
    darkPalette.setColor(QPalette::All, QPalette::Base,        QColor("#1a1a1a"));
    darkPalette.setColor(QPalette::All, QPalette::WindowText,  Qt::white);
    darkPalette.setColor(QPalette::All, QPalette::Text,        Qt::white);
    app.setPalette(darkPalette);

    QCommandLineParser parser;
    QCommandLineOption portOption("port", "Web server port", "port", "8090");
    parser.addOption(portOption);
    parser.process(app);

    int port = parser.value(portOption).toInt();
    if (port <= 0) port = 8090;

    // Show splash immediately — covers the white flash before Qt paints anything
    QSplashScreen* splash = nullptr;
    QPixmap splashPx = loadLogo();
    if (!splashPx.isNull())
    {
        // Pad the logo onto a dark background sized to a reasonable splash
        QPixmap bg(600, 300);
        bg.fill(QColor("#1a1a1a"));
        QPainter painter(&bg);
        QPixmap scaled = splashPx.scaledToWidth(480, Qt::SmoothTransformation);
        int x = (bg.width() - scaled.width()) / 2;
        int y = (bg.height() - scaled.height()) / 2;
        painter.drawPixmap(x, y, scaled);
        painter.end();

        splash = new QSplashScreen(bg, Qt::WindowStaysOnTopHint);
        splash->show();
        app.processEvents(); // force immediate paint
    }

    // Listen for raise signals from the daemon
    QLocalServer::removeServer("hyperhdr-show-window-ui");
    QLocalServer server;
    server.listen("hyperhdr-show-window-ui");

    MainWindow window(port);

    // When page loads, close splash and show main window
    QObject::connect(&window, &MainWindow::pageReady, [&]() {
        if (splash)
        {
            splash->finish(&window);
            delete splash;
            splash = nullptr;
        }
        window.show();
        window.raise();
        window.activateWindow();
    });

    // If no splash, show normally
    if (!splash)
        window.show();

    QObject::connect(&server, &QLocalServer::newConnection, &window, [&server, &window]() {
        QLocalSocket* socket = server.nextPendingConnection();
        QObject::connect(socket, &QLocalSocket::readyRead, &window, [socket, &window]() {
            if (socket->readAll().contains("show"))
            {
                window.show();
                window.raise();
                window.activateWindow();
            }
            socket->deleteLater();
        });
    });

    return app.exec();
}
