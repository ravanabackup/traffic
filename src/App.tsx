import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SpeedLog = {
  timestamp: number;
  timeLabel: string;
  speed: number;
  lat?: number;
  lon?: number;
  countdown?: number | null;
};

type StopLog = {
  startTime: number;
  endTime: number;
  durationSeconds: number;
  lat?: number;
  lon?: number;
  countdownAtStop?: number | null;
};

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
};

const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export default function App() {
  const [countdownInput, setCountdownInput] = useState(45);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownRunning, setCountdownRunning] = useState(false);
  const [announced, setAnnounced] = useState({ twenty: false, twelve: false });
  const [chimeActive, setChimeActive] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [coords, setCoords] = useState<{ lat?: number; lon?: number }>({});
  const [tripActive, setTripActive] = useState(false);
  const [speedLogs, setSpeedLogs] = useState<SpeedLog[]>([]);
  const [stopLogs, setStopLogs] = useState<StopLog[]>([]);
  const [manualMode, setManualMode] = useState(false);
  const [manualSpeed, setManualSpeed] = useState(0);
  const [geoStatus, setGeoStatus] = useState("Idle");
  const [wakeLockEnabled, setWakeLockEnabled] = useState(false);
  const [wakeLockStatus, setWakeLockStatus] = useState("Off");
  const [pipStatus, setPipStatus] = useState("Off");

  const countdownTimerRef = useRef<number | null>(null);
  const chimeIntervalRef = useRef<number | null>(null);
  const speedLogIntervalRef = useRef<number | null>(null);
  const geoWatchRef = useRef<number | null>(null);
  const lastPositionRef = useRef<{ lat: number; lon: number; time: number } | null>(null);
  const currentStopRef = useRef<{
    startTime: number;
    lat?: number;
    lon?: number;
    countdownAtStop?: number | null;
  } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const lastSpeedRef = useRef(0);
  const speedRef = useRef(0);
  const coordsRef = useRef<{ lat?: number; lon?: number }>({});
  const countdownRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    speedRef.current = speed;
    coordsRef.current = coords;
    countdownRef.current = countdown;
  }, [speed, coords, countdown]);

  useEffect(() => {
    const synth = window.speechSynthesis;
    const pickVoice = () => {
      const voices = synth.getVoices();
      if (!voices.length) return;
      const preferred = voices.find((voice) =>
        [
          "female",
          "woman",
          "zira",
          "samantha",
          "google uk english female",
          "microsoft arial",
        ].some((key) => voice.name.toLowerCase().includes(key))
      );
      voiceRef.current = preferred ?? voices[0] ?? null;
    };
    pickVoice();
    synth.addEventListener("voiceschanged", pickVoice);
    return () => synth.removeEventListener("voiceschanged", pickVoice);
  }, []);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    if (voiceRef.current) utterance.voice = voiceRef.current;
    utterance.rate = 1;
    utterance.pitch = 1.2;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, []);

  const playChime = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    ctx.resume();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.6, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.45);
  };

  const requestWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator)) {
      setWakeLockStatus("Unsupported");
      return;
    }
    try {
      const sentinel = await (navigator as any).wakeLock.request("screen");
      wakeLockRef.current = sentinel;
      setWakeLockStatus("On");
      sentinel.addEventListener("release", () => {
        setWakeLockStatus("Off");
      });
    } catch (error) {
      setWakeLockStatus("Denied");
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } finally {
      setWakeLockStatus("Off");
    }
  }, []);

  const startPiP = useCallback(async () => {
    if (!document.pictureInPictureEnabled) {
      setPipStatus("Unsupported");
      return;
    }
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    if (!pipStreamRef.current) {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = 320;
      canvas.height = 180;
      const draw = () => {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#34d399";
        ctx.font = "bold 28px Inter, sans-serif";
        ctx.fillText(`${countdownRef.current ?? "--"}s`, 18, 56);
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "16px Inter, sans-serif";
        ctx.fillText(`Speed ${speedRef.current.toFixed(1)} km/h`, 18, 92);
        ctx.fillStyle = "#38bdf8";
        ctx.font = "12px Inter, sans-serif";
        ctx.fillText("Signal Green", 18, 125);
        rafRef.current = requestAnimationFrame(draw);
      };
      draw();
      pipStreamRef.current = canvas.captureStream(2);
    }

    video.srcObject = pipStreamRef.current;
    await video.play();
    await (video as any).requestPictureInPicture();
    setPipStatus("On");
  }, []);

  const stopPiP = useCallback(async () => {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    }
    setPipStatus("Off");
  }, []);

  useEffect(() => {
    if (chimeActive) {
      if (chimeIntervalRef.current) return;
      chimeIntervalRef.current = window.setInterval(() => {
        playChime();
      }, 900);
    } else if (chimeIntervalRef.current) {
      window.clearInterval(chimeIntervalRef.current);
      chimeIntervalRef.current = null;
    }
  }, [chimeActive]);

  useEffect(() => {
    if (wakeLockEnabled) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
  }, [wakeLockEnabled, requestWakeLock, releaseWakeLock]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && wakeLockEnabled) {
        requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [wakeLockEnabled, requestWakeLock]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handleLeave = () => setPipStatus("Off");
    video.addEventListener("leavepictureinpicture", handleLeave);
    return () => {
      video.removeEventListener("leavepictureinpicture", handleLeave);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (countdownRunning && countdown === null) {
      setCountdown(countdownInput);
    }
  }, [countdownRunning, countdown, countdownInput]);

  useEffect(() => {
    if (!countdownRunning || countdown === null) return;
    if (countdownTimerRef.current) return;
    countdownTimerRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) return prev;
        if (prev <= 0) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (countdownTimerRef.current) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [countdownRunning, countdown]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdownRunning(false);
      if (countdownTimerRef.current) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      return;
    }
    if (countdown === 20 && !announced.twenty) {
      speak("Twenty seconds left. Turn on the engine.");
      setAnnounced((prev) => ({ ...prev, twenty: true }));
    }
    if (countdown === 12 && !announced.twelve) {
      speak("Twelve seconds left. Start the bike.");
      setAnnounced((prev) => ({ ...prev, twelve: true }));
    }
    if (countdown === 5) {
      setChimeActive(true);
    }
  }, [countdown, announced, speak]);

  useEffect(() => {
    if (!tripActive) return;
    if (!navigator.geolocation) {
      setGeoStatus("Geolocation not available");
      return;
    }
    setGeoStatus("Tracking...");
    geoWatchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, speed: rawSpeed } = position.coords;
        setCoords({ lat: latitude, lon: longitude });
        let calculatedSpeed = 0;
        if (rawSpeed !== null && rawSpeed !== undefined) {
          calculatedSpeed = Math.max(0, rawSpeed * 3.6);
        } else if (lastPositionRef.current) {
          const distance = haversine(
            lastPositionRef.current.lat,
            lastPositionRef.current.lon,
            latitude,
            longitude
          );
          const timeDiff = (position.timestamp - lastPositionRef.current.time) / 1000;
          if (timeDiff > 0) {
            calculatedSpeed = Math.max(0, (distance / timeDiff) * 3.6);
          }
        }
        lastPositionRef.current = { lat: latitude, lon: longitude, time: position.timestamp };
        if (!manualMode) {
          setSpeed(Number(calculatedSpeed.toFixed(1)));
        }
      },
      (error) => {
        setGeoStatus(`Location error: ${error.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
    return () => {
      if (geoWatchRef.current !== null) {
        navigator.geolocation.clearWatch(geoWatchRef.current);
        geoWatchRef.current = null;
      }
    };
  }, [tripActive, manualMode]);

  useEffect(() => {
    if (!tripActive) return;
    if (speedLogIntervalRef.current) return;
    speedLogIntervalRef.current = window.setInterval(() => {
      const currentSpeed = speedRef.current;
      const log: SpeedLog = {
        timestamp: Date.now(),
        timeLabel: formatTime(Date.now()),
        speed: currentSpeed,
        lat: coordsRef.current.lat,
        lon: coordsRef.current.lon,
        countdown: countdownRef.current,
      };
      setSpeedLogs((prev) => [...prev.slice(-600), log]);
    }, 1000);
    return () => {
      if (speedLogIntervalRef.current) {
        window.clearInterval(speedLogIntervalRef.current);
        speedLogIntervalRef.current = null;
      }
    };
  }, [tripActive]);

  useEffect(() => {
    if (!tripActive) return;
    if (manualMode) {
      setSpeed(manualSpeed);
    }
  }, [manualMode, manualSpeed, tripActive]);

  useEffect(() => {
    if (!tripActive) return;
    const moving = speed > 1;
    const wasMoving = lastSpeedRef.current > 1;

    if (!moving && wasMoving) {
      currentStopRef.current = {
        startTime: Date.now(),
        lat: coords.lat,
        lon: coords.lon,
        countdownAtStop: countdown,
      };
      speak("Vehicle stopped. Logging signal wait.");
    }

    if (moving && currentStopRef.current) {
      const stop = currentStopRef.current;
      const endTime = Date.now();
      const durationSeconds = (endTime - stop.startTime) / 1000;
      setStopLogs((prev) => [
        ...prev,
        {
          startTime: stop.startTime,
          endTime,
          durationSeconds,
          lat: stop.lat,
          lon: stop.lon,
          countdownAtStop: stop.countdownAtStop,
        },
      ]);
      currentStopRef.current = null;
    }

    if (speed >= 50 && lastSpeedRef.current < 50) {
      speak("Slow down sir. You are above fifty kilometers per hour.");
    }

    if (moving && chimeActive) {
      setChimeActive(false);
    }

    lastSpeedRef.current = speed;
  }, [speed, chimeActive, coords, countdown, tripActive]);

  const startCountdown = () => {
    setCountdown(countdownInput);
    setCountdownRunning(true);
    setAnnounced({ twenty: false, twelve: false });
    setChimeActive(false);
  };

  const stopCountdown = () => {
    setCountdownRunning(false);
    setChimeActive(false);
  };

  const startTrip = () => {
    setTripActive(true);
    setSpeedLogs([]);
    setStopLogs([]);
    setGeoStatus("Tracking...");
    setCountdown(null);
    setCountdownRunning(false);
    lastPositionRef.current = null;
    currentStopRef.current = null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    audioCtxRef.current.resume();
    speak("Trip started. Stay alert.");
  };

  const endTrip = () => {
    setTripActive(false);
    setCountdownRunning(false);
    setChimeActive(false);
    if (currentStopRef.current) {
      const stop = currentStopRef.current;
      const endTime = Date.now();
      setStopLogs((prev) => [
        ...prev,
        {
          startTime: stop.startTime,
          endTime,
          durationSeconds: (endTime - stop.startTime) / 1000,
          lat: stop.lat,
          lon: stop.lon,
          countdownAtStop: stop.countdownAtStop,
        },
      ]);
      currentStopRef.current = null;
    }
    speak("Trip ended. Export your log when ready.");
  };

  const exportLog = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      speedLogs,
      stopLogs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `signal-trip-log-${new Date().toISOString().slice(0, 19)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const stopSummary = useMemo(() => {
    const total = stopLogs.reduce((acc, stop) => acc + stop.durationSeconds, 0);
    return {
      totalStops: stopLogs.length,
      totalStoppedTime: formatDuration(total),
    };
  }, [stopLogs]);

  const handlePiP = useCallback(() => {
    if (document.pictureInPictureElement) {
      stopPiP();
    } else {
      startPiP();
    }
  }, [startPiP, stopPiP]);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-4 pb-10 pt-6">
        <header className="space-y-2 text-center">
          <p className="text-xs uppercase tracking-[0.3em] text-emerald-400">Amoled Signal</p>
          <h1 className="text-2xl font-semibold">Green Light Companion</h1>
          <p className="text-sm text-slate-400">Countdown alerts, speed coaching, and smart trip logs.</p>
        </header>

        <section className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-transparent p-4">
            <p className="text-xs text-emerald-300">Current Speed</p>
            <p className="mt-3 text-3xl font-semibold">{speed.toFixed(1)}</p>
            <p className="text-xs text-slate-400">km/h</p>
          </div>
          <div className="rounded-2xl border border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 to-transparent p-4">
            <p className="text-xs text-cyan-300">Countdown</p>
            <p className="mt-3 text-3xl font-semibold">
              {countdown !== null ? `${countdown}s` : "--"}
            </p>
            <p className="text-xs text-slate-400">{countdownRunning ? "Running" : "Idle"}</p>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-lg shadow-emerald-500/10">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Traffic Signal Countdown</p>
              <p className="text-xs text-slate-400">Enter seconds until green.</p>
            </div>
            <span className={`text-xs ${chimeActive ? "text-emerald-400" : "text-slate-500"}`}>
              {chimeActive ? "Chime ON" : "Chime OFF"}
            </span>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <input
              type="number"
              min={5}
              value={countdownInput}
              onChange={(event) => setCountdownInput(Number(event.target.value))}
              className="w-24 rounded-xl border border-white/10 bg-black px-3 py-2 text-lg text-white"
            />
            <button
              onClick={startCountdown}
              className="flex-1 rounded-xl bg-emerald-500/90 px-4 py-3 text-sm font-semibold text-black"
            >
              Start
            </button>
            <button
              onClick={stopCountdown}
              className="rounded-xl border border-white/10 px-4 py-3 text-sm text-white"
            >
              Stop
            </button>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Alerts at 20s (engine), 12s (start), 5s (chime until moving).
          </p>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Trip Status</p>
              <p className="text-xs text-slate-400">{geoStatus}</p>
            </div>
            <div className={`text-xs ${tripActive ? "text-emerald-400" : "text-slate-500"}`}>
              {tripActive ? "Active" : "Inactive"}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              onClick={startTrip}
              className="rounded-xl bg-emerald-500/90 px-4 py-3 text-sm font-semibold text-black"
            >
              Trip Start
            </button>
            <button
              onClick={endTrip}
              className="rounded-xl border border-white/10 px-4 py-3 text-sm text-white"
            >
              Trip End
            </button>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-xl border border-white/10 bg-black/40 px-3 py-2">
            <div>
              <p className="text-xs text-slate-400">Manual Speed Mode</p>
              <p className="text-sm">{manualMode ? "On" : "Off"}</p>
            </div>
            <button
              onClick={() => setManualMode((prev) => !prev)}
              className={`rounded-full px-4 py-2 text-xs font-semibold ${
                manualMode ? "bg-emerald-400 text-black" : "bg-white/10 text-white"
              }`}
            >
              {manualMode ? "Disable" : "Enable"}
            </button>
          </div>
          {manualMode && (
            <div className="mt-3">
              <input
                type="range"
                min={0}
                max={100}
                value={manualSpeed}
                onChange={(event) => setManualSpeed(Number(event.target.value))}
                className="w-full"
              />
              <p className="mt-1 text-xs text-slate-400">Manual speed: {manualSpeed} km/h</p>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Device Controls</p>
              <p className="text-xs text-slate-400">Prevent screen lock & keep PiP active.</p>
            </div>
            <div className="text-xs text-slate-500">Keep alive</div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              onClick={() => setWakeLockEnabled((prev) => !prev)}
              className={`rounded-xl px-4 py-3 text-sm font-semibold ${
                wakeLockEnabled ? "bg-emerald-500/90 text-black" : "border border-white/10 text-white"
              }`}
            >
              {wakeLockEnabled ? "Wake Lock On" : "Enable Wake Lock"}
            </button>
            <button
              onClick={handlePiP}
              className={`rounded-xl px-4 py-3 text-sm font-semibold ${
                pipStatus === "On"
                  ? "bg-cyan-500/90 text-black"
                  : "border border-white/10 text-white"
              }`}
            >
              {pipStatus === "On" ? "Close PiP" : "Open PiP"}
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-400">
            <div className="rounded-xl border border-white/10 bg-black/40 p-3">
              <p className="text-slate-400">Wake Lock</p>
              <p className="mt-2 text-sm font-semibold text-white">{wakeLockStatus}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/40 p-3">
              <p className="text-slate-400">PiP Status</p>
              <p className="mt-2 text-sm font-semibold text-white">{pipStatus}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Note: Wake Lock helps prevent screen off, but some devices still throttle background
            activity. Keep the app foreground for best results.
          </p>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Trip Insights</p>
              <p className="text-xs text-slate-400">Stops, logs, and export.</p>
            </div>
            <button
              onClick={exportLog}
              className="rounded-xl bg-cyan-500/90 px-4 py-2 text-xs font-semibold text-black"
            >
              Export Log
            </button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-white/10 bg-black/40 p-3">
              <p className="text-slate-400">Stops Recorded</p>
              <p className="mt-2 text-lg font-semibold text-white">{stopSummary.totalStops}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/40 p-3">
              <p className="text-slate-400">Total Stopped</p>
              <p className="mt-2 text-lg font-semibold text-white">{stopSummary.totalStoppedTime}</p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-emerald-300">Stop Log</h2>
          {stopLogs.length === 0 && (
            <p className="text-xs text-slate-500">No stops logged yet. Ride safe.</p>
          )}
          {stopLogs
            .slice()
            .reverse()
            .slice(0, 4)
            .map((stop, index) => (
              <div
                key={`${stop.startTime}-${index}`}
                className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-transparent p-4"
              >
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Stop {stopLogs.length - index}</span>
                  <span>{formatDuration(stop.durationSeconds)}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-white">
                  {formatTime(stop.startTime)} → {formatTime(stop.endTime)}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {stop.lat !== undefined && stop.lon !== undefined
                    ? `Lat ${stop.lat.toFixed(5)} · Lon ${stop.lon.toFixed(5)}`
                    : "Location unavailable"}
                </p>
                <p className="mt-2 text-xs text-emerald-300">
                  Countdown at stop: {stop.countdownAtStop ?? "--"}s
                </p>
              </div>
            ))}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-cyan-300">Speed Stream (last 12)</h2>
          <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4">
            <div className="grid grid-cols-3 gap-2 text-xs text-slate-400">
              <span>Time</span>
              <span>Speed</span>
              <span>Countdown</span>
            </div>
            <div className="mt-3 space-y-2 text-xs">
              {speedLogs.length === 0 && <p className="text-slate-500">Waiting for data...</p>}
              {speedLogs
                .slice()
                .reverse()
                .slice(0, 12)
                .map((log) => (
                  <div key={log.timestamp} className="grid grid-cols-3 gap-2">
                    <span className="text-white">{log.timeLabel}</span>
                    <span className="text-cyan-200">{log.speed.toFixed(1)} km/h</span>
                    <span className="text-slate-400">{log.countdown ?? "--"}s</span>
                  </div>
                ))}
            </div>
          </div>
        </section>

        <div className="hidden">
          <video ref={videoRef} muted playsInline />
          <canvas ref={canvasRef} />
        </div>
      </div>
    </div>
  );
}
