#pragma once

#include <QObject>
#include <QProcess>
#include <QCoreApplication>
#include <QLocalSocket>
#include <QSettings>

// Manages the hyperhdr-ui child process.
// The main daemon never loads WebEngine/Chromium at all.
// All RAM is in the child process and freed when the window is closed.
//
// Keep-loaded mode: when enabled the child process is started at daemon
// startup and is never killed when the window is closed — only hidden.
// This trades idle RAM for instant reopen (no Chromium cold-start).
// The preference is persisted in QSettings so it survives restarts.

class UiLauncher : public QObject
{
	Q_OBJECT

public:
	explicit UiLauncher(int port, QObject* parent = nullptr)
		: QObject(parent)
		, _port(port)
	{
		// Restore persisted preference
		QSettings s("HyperHDR", "HyperHDR");
		_keepLoaded = s.value("ui/keepLoaded", false).toBool();

		// If keep-loaded was on last session, pre-start the process now
		// so the UI is warm before the user ever clicks the tray icon.
		if (_keepLoaded)
			_startProcess(/*showWindow=*/false);
	}

	~UiLauncher()
	{
		kill();
	}

	// ── keep-loaded toggle ────────────────────────────────────────────────────

	bool keepLoaded() const { return _keepLoaded; }

	void setKeepLoaded(bool enabled)
	{
		if (_keepLoaded == enabled)
			return;

		_keepLoaded = enabled;

		QSettings s("HyperHDR", "HyperHDR");
		s.setValue("ui/keepLoaded", _keepLoaded);

		if (_keepLoaded)
		{
			// If the process is already running (window visible or not), we need
			// to restart it with --keep-loaded so it knows to hide on close.
			// Kill it first, then restart preserving visibility.
			bool wasVisible = _windowVisible;
			kill();
			_startProcess(/*showWindow=*/wasVisible);
		}
		else
		{
			// Keep-loaded turned off — restart without --keep-loaded flag so the
			// window will quit on close again. If currently hidden, kill now to
			// free RAM immediately. If visible, restart so close works correctly.
			bool wasVisible = _windowVisible;
			kill();
			if (wasVisible)
				_startProcess(/*showWindow=*/true);
			// If it was hidden (background), just leave it dead — it will spawn
			// fresh on next show() call.
		}
	}

	// ── show / hide ───────────────────────────────────────────────────────────

	void show()
	{
		if (_process != nullptr && _process->state() == QProcess::Running)
		{
			// Already running — send "show" signal to raise the window.
			_sendIpc("show");
			_windowVisible = true;
			return;
		}

		_startProcess(/*showWindow=*/true);
	}

	void hide()
	{
		if (_process == nullptr || _process->state() != QProcess::Running)
			return;

		if (_keepLoaded)
		{
			// Keep-loaded: just hide the window, leave the process alive.
			_sendIpc("hide");
			_windowVisible = false;
		}
		else
		{
			// Normal mode: kill the process to free RAM.
			kill();
		}
	}

	void kill()
	{
		if (_process != nullptr)
		{
			// Ask the UI process to quit cleanly before we force-terminate.
			if (_process->state() == QProcess::Running)
				_sendIpc("quit");
			_process->terminate();
			if (!_process->waitForFinished(2000))
				_process->kill();
			delete _process;
			_process = nullptr;
		}
		_windowVisible = false;
	}

	bool isRunning() const
	{
		return _process != nullptr && _process->state() == QProcess::Running;
	}

private:
	// Send a short IPC command to the running UI process.
	void _sendIpc(const char* command)
	{
		QLocalSocket socket;
		socket.connectToServer("hyperhdr-show-window-ui");
		if (socket.waitForConnected(100))
		{
			socket.write(command);
			socket.flush();
			socket.waitForBytesWritten(100);
		}
	}

	// Spawn the child process. If showWindow is false the process starts
	// but the window stays hidden (used for background pre-warming).
	void _startProcess(bool showWindow)
	{
		if (_process != nullptr && _process->state() == QProcess::Running)
			return;

		QString uiExe = QCoreApplication::applicationDirPath()
#ifdef _WIN32
			+ "/hyperhdr-ui.exe";
#else
			+ "/hyperhdr-ui";
#endif

		_process = new QProcess(this);
		_process->setProgram(uiExe);

		QStringList args{ "--port", QString::number(_port) };
		if (!showWindow)
			args << "--hidden";       // start with window hidden (pre-warm)
		if (_keepLoaded)
			args << "--keep-loaded";  // tell UI process: hide on close, don't quit
		_process->setArguments(args);

		connect(_process, &QProcess::finished, this, [this]() {
			_process->deleteLater();
			_process = nullptr;
			_windowVisible = false;
		});

		_process->start();
		_windowVisible = showWindow;
	}

	QProcess* _process       = nullptr;
	int       _port          = 8090;
	bool      _keepLoaded    = false;
	bool      _windowVisible = false;
};
