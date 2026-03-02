#pragma once

#include <QObject>
#include <QProcess>
#include <QCoreApplication>
#include <QLocalSocket>

// Manages the hyperhdr-ui.exe child process.
// The main daemon never loads WebEngine/Chromium at all.
// All RAM is in the child process and freed when the window is closed.

class UiLauncher : public QObject
{
	Q_OBJECT

public:
	explicit UiLauncher(int port, QObject* parent = nullptr)
		: QObject(parent)
		, _port(port)
	{
	}

	~UiLauncher()
	{
		kill();
	}

	void show()
	{
		if (_process != nullptr && _process->state() == QProcess::Running)
		{
			// Already running — send signal to raise window
			QLocalSocket socket;
			socket.connectToServer("hyperhdr-show-window-ui");
			if (socket.waitForConnected(500))
			{
				socket.write("show");
				socket.flush();
				socket.waitForBytesWritten(500);
			}
			return;
		}

		QString uiExe = QCoreApplication::applicationDirPath()
#ifdef _WIN32
			+ "/hyperhdr-ui.exe";
#else
			+ "/hyperhdr-ui";
#endif

		_process = new QProcess(this);
		_process->setProgram(uiExe);
		_process->setArguments({ "--port", QString::number(_port) });

		connect(_process, &QProcess::finished, this, [this]() {
			_process->deleteLater();
			_process = nullptr;
		});

		_process->start();
	}

	void kill()
	{
		if (_process != nullptr)
		{
			_process->terminate();
			if (!_process->waitForFinished(2000))
				_process->kill();
			delete _process;
			_process = nullptr;
		}
	}

	bool isRunning() const
	{
		return _process != nullptr && _process->state() == QProcess::Running;
	}

private:
	QProcess* _process = nullptr;
	int       _port    = 8090;
};
