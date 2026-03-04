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

#ifdef _WIN32
#include <windows.h>
#include <shellscalingapi.h>
#pragma comment(lib, "Shcore.lib")
#endif

// ── loadLogo ──────────────────────────────────────────────────────────────────

static QPixmap loadLogo()
{
    QString logoPath = QCoreApplication::applicationDirPath() + "/logo.jpg";
    QPixmap px(logoPath);
    if (px.isNull())
        px = QPixmap(QCoreApplication::applicationDirPath() + "/logo.png");
    return px;
}

// ── TitleBar ──────────────────────────────────────────────────────────────────
// Transparent overlay bar floating over the top of the webview.
// Contains only ─  □  ✕ on the right; no title text.

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
        _dragActive = false;

        QHBoxLayout* layout = new QHBoxLayout(this);
        layout->setContentsMargins(0, 0, 6, 0);
        layout->setSpacing(2);
        layout->addStretch();   // push buttons to right

        // ── shared button style helpers ───────────────────────────────────────
        auto makeBtn = [&](const QString& glyph, int w) -> QPushButton* {
            auto* btn = new QPushButton(glyph, this);
            btn->setFixedSize(w, 22);
            btn->setCursor(Qt::ArrowCursor);
            btn->setFlat(true);
            return btn;
        };

        // Minimize ─
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

        // Maximize □ / Restore ❐
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

        // Close ✕
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

    // Update □/❐ icon from outside (e.g. after F11 restore)
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

            _dragActive   = true;
            _dragStartPos = event->globalPos() - _mainWindow->frameGeometry().topLeft();
            event->accept();
        }
    }

    void mouseMoveEvent(QMouseEvent* event) override
    {
        if (_dragActive && (event->buttons() & Qt::LeftButton))
        {
            if (_mainWindow->isMaximized() || _mainWindow->isFullScreen())
            { _mainWindow->showNormal(); syncMaxButton(); }
            _mainWindow->move(event->globalPos() - _dragStartPos);
            event->accept();
        }
    }

    void mouseReleaseEvent(QMouseEvent* event) override
    {
        _dragActive = false;
        QWidget::mouseReleaseEvent(event);
    }

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
    bool         _dragActive  = false;
    QPoint       _dragStartPos;
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
    explicit MainWindow(int port, QWidget* parent = nullptr)
        : QMainWindow(parent)
        , _port(port)
        , _storagePath(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/webprofile")
    {
        // ── Frameless window ──────────────────────────────────────────────────
        setWindowFlags(Qt::FramelessWindowHint | Qt::Window);
        setAttribute(Qt::WA_TranslucentBackground, false);

        setWindowTitle("HyperHDR");
        setWindowIcon(QIcon(":/hyperhdr.png"));
        resize(1280, 800);
        setGeometry(QStyle::alignedRect(Qt::LeftToRight, Qt::AlignCenter,
            size(), QApplication::primaryScreen()->availableGeometry()));

        // Stacked widget: index 0 = loading screen, index 1 = web container
        _stack = new QStackedWidget(this);
        setCentralWidget(_stack);

        // ── Page 0: loading screen ────────────────────────────────────────────
        QWidget* loadPage = new QWidget();
        loadPage->setStyleSheet("background-color: #1a1a1a;");
        QVBoxLayout* loadLayout = new QVBoxLayout(loadPage);
        loadLayout->setAlignment(Qt::AlignCenter);
        QLabel* logo = new QLabel();
        QPixmap px = loadLogo();
        if (!px.isNull())
            logo->setPixmap(px.scaledToWidth(480, Qt::SmoothTransformation));
        else
            logo->setText("HyperHDR");
        logo->setAlignment(Qt::AlignCenter);
        loadLayout->addWidget(logo);
        _stack->addWidget(loadPage);   // index 0

        // ── Page 1: web container with floating title bar ─────────────────────
        _webContainer = new QWidget();
        _webContainer->setStyleSheet("background: #1a1a1a;");

        // QVBoxLayout fills the container with the webview
        QVBoxLayout* webLayout = new QVBoxLayout(_webContainer);
        webLayout->setContentsMargins(0, 0, 0, 0);
        webLayout->setSpacing(0);

        _profile = new QWebEngineProfile("hyperhdr", this);
        _profile->setPersistentStoragePath(_storagePath);
        _profile->setCachePath(_storagePath + "/cache");
        _profile->setPersistentCookiesPolicy(QWebEngineProfile::ForcePersistentCookies);
        _profile->setHttpCacheType(QWebEngineProfile::DiskHttpCache);
        _profile->settings()->setAttribute(QWebEngineSettings::FullScreenSupportEnabled, true);

        _view = new QWebEngineView(_webContainer);
        _view->setPage(new LocalWebPage(_profile, _view));
        webLayout->addWidget(_view);

        _stack->addWidget(_webContainer);   // index 1

        // Title bar floats over the entire stack — parented to _stack so it is
        // NOT a child of _webContainer and therefore invisible during page 0 (loading screen)
        _titleBar = new TitleBar(this, _stack);
        _titleBar->hide();   // hidden until the web page finishes loading
        _titleBar->raise();
        _titleBar->setGeometry(0, 0, _stack->width(), 36);

        // ── Connections ───────────────────────────────────────────────────────
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

        connect(_view, &QWebEngineView::loadFinished, this, [this](bool) {
            _stack->setCurrentIndex(1);
            _titleBar->setGeometry(0, 0, _stack->width(), 36);
            _titleBar->show();   // reveal only now — loading screen is gone
            _titleBar->raise();
            emit pageReady();
        });

        _view->load(QUrl(QString("http://localhost:%1").arg(_port)));
        _stack->setCurrentIndex(0);

        // F11 / Escape
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

protected:
    // Keep title bar stretched across the top on every resize
    void resizeEvent(QResizeEvent* event) override
    {
        QMainWindow::resizeEvent(event);
        if (_titleBar && _stack)
            _titleBar->setGeometry(0, 0, _stack->width(), 36);
    }

    void closeEvent(QCloseEvent* event) override
    {
        if (isFullScreen()) showNormal();
        event->accept();
        QApplication::quit();
    }

    // Edge-resize for the frameless window
    void mousePressEvent(QMouseEvent* event) override
    {
        if (event->button() == Qt::LeftButton)
        {
            _resizeEdge = hitTest(event->pos());
            if (_resizeEdge != Qt::Edges{})
            {
                _resizeStartGlobal = event->globalPos();
                _resizeStartGeom   = geometry();
                event->accept();
                return;
            }
        }
        QMainWindow::mousePressEvent(event);
    }

    void mouseMoveEvent(QMouseEvent* event) override
    {
        if ((event->buttons() & Qt::LeftButton) && _resizeEdge != Qt::Edges{})
        {
            QPoint delta = event->globalPos() - _resizeStartGlobal;
            QRect  r     = _resizeStartGeom;
            const int minW = 400, minH = 300;

            if (_resizeEdge & Qt::LeftEdge)   r.setLeft  (qMin(r.left()   + delta.x(), r.right()  - minW));
            if (_resizeEdge & Qt::RightEdge)  r.setRight (qMax(r.right()  + delta.x(), r.left()   + minW));
            if (_resizeEdge & Qt::TopEdge)    r.setTop   (qMin(r.top()    + delta.y(), r.bottom() - minH));
            if (_resizeEdge & Qt::BottomEdge) r.setBottom(qMax(r.bottom() + delta.y(), r.top()    + minH));

            setGeometry(r);
            event->accept();
            return;
        }

        // Cursor feedback at edges
        Qt::Edges edge = hitTest(event->pos());
        if      (edge == (Qt::LeftEdge  | Qt::TopEdge)    || edge == (Qt::RightEdge | Qt::BottomEdge)) setCursor(Qt::SizeFDiagCursor);
        else if (edge == (Qt::RightEdge | Qt::TopEdge)    || edge == (Qt::LeftEdge  | Qt::BottomEdge)) setCursor(Qt::SizeBDiagCursor);
        else if (edge & Qt::LeftEdge  || edge & Qt::RightEdge)  setCursor(Qt::SizeHorCursor);
        else if (edge & Qt::TopEdge   || edge & Qt::BottomEdge) setCursor(Qt::SizeVerCursor);
        else unsetCursor();

        QMainWindow::mouseMoveEvent(event);
    }

    void mouseReleaseEvent(QMouseEvent* event) override
    {
        _resizeEdge = Qt::Edges{};
        QMainWindow::mouseReleaseEvent(event);
    }

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
    QString            _storagePath;

    Qt::Edges          _resizeEdge;
    QPoint             _resizeStartGlobal;
    QRect              _resizeStartGeom;
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

    QApplication::setStyle("fusion");
    QApplication::setAttribute(Qt::AA_UseHighDpiPixmaps);

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
    parser.addOption(portOption);
    parser.process(app);

    int port = parser.value(portOption).toInt();
    if (port <= 0) port = 8090;

    QSplashScreen* splash = nullptr;
    QPixmap splashPx = loadLogo();
    if (!splashPx.isNull())
    {
        QPixmap bg(600, 300);
        bg.fill(QColor("#1a1a1a"));
        QPainter painter(&bg);
        QPixmap scaled = splashPx.scaledToWidth(480, Qt::SmoothTransformation);
        painter.drawPixmap((bg.width() - scaled.width()) / 2,
                           (bg.height() - scaled.height()) / 2, scaled);
        painter.end();

        splash = new QSplashScreen(bg, Qt::WindowStaysOnTopHint | Qt::FramelessWindowHint);
        splash->show();
        app.processEvents();
    }

    QLocalServer::removeServer("hyperhdr-show-window-ui");
    QLocalServer server;
    server.listen("hyperhdr-show-window-ui");

    MainWindow window(port);

    QObject::connect(&window, &MainWindow::pageReady, [&]() {
        if (splash) { splash->finish(&window); delete splash; splash = nullptr; }
        window.show();
        window.raise();
        window.activateWindow();
    });

    if (!splash) window.show();

    QObject::connect(&server, &QLocalServer::newConnection, &window,
        [&server, &window]() {
            QLocalSocket* socket = server.nextPendingConnection();
            QObject::connect(socket, &QLocalSocket::readyRead, &window,
                [socket, &window]() {
                    if (socket->readAll().contains("show"))
                    { window.show(); window.raise(); window.activateWindow(); }
                    socket->deleteLater();
                });
        });

    return app.exec();
}