// audio_shims.js - Native miniaudio backend for RMMZ AudioManager.
// Loaded after shims.js, before rmmz_core.js.
// Routes AudioManager methods directly through native miniaudio,
// bypassing the WebAudio API shim entirely.
(function () {
    "use strict";
    var native = globalThis.__native__;
    if (!native || !native.audioPlay) {
        print("[audio_shims] native audio API not available, skipping");
        return;
    }
    if (typeof AudioManager === "undefined") {
        print("[audio_shims] AudioManager not defined yet, skipping");
        return;
    }
    native.audioInit();
    var _bgmHandle = -1;
    var _bgsHandle = -1;
    var _meHandle = -1;
    var _seHandles = [];
    var _staticHandles = [];
    var _bgmVolume = 100;
    var _bgsVolume = 100;
    var _meVolume = 100;
    var _seVolume = 100;
    function audioPath(folder, name) {
        var ext = AudioManager.audioFileExt ? AudioManager.audioFileExt() : ".ogg";
        return AudioManager._path + folder + encodeURIComponent(name) + ext;
    }
    function computeVolume(configVol, audioVol) {
        return ((configVol || 100) * (audioVol || 0)) / 10000;
    }
    function computePitch(audioPitch) {
        return (audioPitch || 0) / 100;
    }
    function computePan(audioPan) {
        return (audioPan || 0) / 100;
    }
    function stopHandle(h) {
        if (h >= 0) { native.audioStop(h); native.audioUninit(h); }
    }
    AudioManager.playBgm = function (bgm, pos) {
        if (this.isCurrentBgm(bgm)) {
            this.updateBgmParameters(bgm);
        } else {
            this.stopBgm();
            if (bgm.name) {
                var vol = computeVolume(this._bgmVolume, bgm.volume);
                var pitch = computePitch(bgm.pitch);
                var pan = computePan(bgm.pan);
                _bgmHandle = native.audioPlay(audioPath("bgm/", bgm.name), vol, true, pitch, pan);
                if (_bgmHandle >= 0 && pos > 0) native.audioSeek(_bgmHandle, pos);
            }
        }
        this.updateCurrentBgm(bgm, pos);
    };
    AudioManager.replayBgm = function (bgm) {
        if (this.isCurrentBgm(bgm)) { this.updateBgmParameters(bgm); }
        else { this.playBgm(bgm, bgm.pos); }
    };
    AudioManager.isCurrentBgm = function (bgm) {
        return this._currentBgm && _bgmHandle >= 0 && this._currentBgm.name === bgm.name;
    };
    AudioManager.updateBgmParameters = function (bgm) {
        if (_bgmHandle >= 0 && bgm) {
            native.audioSetVolume(_bgmHandle, computeVolume(this._bgmVolume, bgm.volume));
            native.audioSetPitch(_bgmHandle, computePitch(bgm.pitch));
            native.audioSetPan(_bgmHandle, computePan(bgm.pan));
        }
    };
    AudioManager.updateCurrentBgm = function (bgm, pos) {
        this._currentBgm = { name: bgm.name, volume: bgm.volume, pitch: bgm.pitch, pan: bgm.pan, pos: pos };
    };
    AudioManager.stopBgm = function () {
        stopHandle(_bgmHandle); _bgmHandle = -1; this._currentBgm = null;
    };
    AudioManager.fadeOutBgm = function (duration) {
        if (_bgmHandle >= 0 && this._currentBgm) {
            native.audioFade(_bgmHandle, computeVolume(this._bgmVolume, this._currentBgm.volume), 0, Math.round(duration * 1000));
            this._currentBgm = null;
        }
    };
    AudioManager.fadeInBgm = function (duration) {
        if (_bgmHandle >= 0) native.audioFade(_bgmHandle, 0, 1.0, Math.round(duration * 1000));
    };
    AudioManager.playBgs = function (bgs, pos) {
        if (this.isCurrentBgs(bgs)) { this.updateBgsParameters(bgs); }
        else {
            this.stopBgs();
            if (bgs.name) {
                var vol = computeVolume(this._bgsVolume, bgs.volume);
                _bgsHandle = native.audioPlay(audioPath("bgs/", bgs.name), vol, true, computePitch(bgs.pitch), computePan(bgs.pan));
                if (_bgsHandle >= 0 && pos > 0) native.audioSeek(_bgsHandle, pos);
            }
        }
        this.updateCurrentBgs(bgs, pos);
    };
    AudioManager.replayBgs = function (bgs) {
        if (this.isCurrentBgs(bgs)) { this.updateBgsParameters(bgs); }
        else { this.playBgs(bgs, bgs.pos); }
    };
    AudioManager.isCurrentBgs = function (bgs) {
        return this._currentBgs && _bgsHandle >= 0 && this._currentBgs.name === bgs.name;
    };
    AudioManager.updateBgsParameters = function (bgs) {
        if (_bgsHandle >= 0 && bgs) {
            native.audioSetVolume(_bgsHandle, computeVolume(this._bgsVolume, bgs.volume));
            native.audioSetPitch(_bgsHandle, computePitch(bgs.pitch));
            native.audioSetPan(_bgsHandle, computePan(bgs.pan));
        }
    };
    AudioManager.updateCurrentBgs = function (bgs, pos) {
        this._currentBgs = { name: bgs.name, volume: bgs.volume, pitch: bgs.pitch, pan: bgs.pan, pos: pos };
    };
    AudioManager.stopBgs = function () {
        stopHandle(_bgsHandle); _bgsHandle = -1; this._currentBgs = null;
    };
    AudioManager.fadeOutBgs = function (duration) {
        if (_bgsHandle >= 0 && this._currentBgs) {
            native.audioFade(_bgsHandle, computeVolume(this._bgsVolume, this._currentBgs.volume), 0, Math.round(duration * 1000));
            this._currentBgs = null;
        }
    };
    AudioManager.fadeInBgs = function (duration) {
        if (_bgsHandle >= 0) native.audioFade(_bgsHandle, 0, 1.0, Math.round(duration * 1000));
    };
    AudioManager.playMe = function (me) {
        this.stopMe();
        if (me.name) {
            if (_bgmHandle >= 0 && this._currentBgm) {
                this._currentBgm.pos = native.audioGetCursor(_bgmHandle);
                native.audioStop(_bgmHandle);
            }
            _meHandle = native.audioPlay(audioPath("me/", me.name), computeVolume(this._meVolume, me.volume), false, computePitch(me.pitch), computePan(me.pan));
        }
    };
    AudioManager.updateMeParameters = function (me) {
        if (_meHandle >= 0 && me) {
            native.audioSetVolume(_meHandle, computeVolume(this._meVolume, me.volume));
            native.audioSetPitch(_meHandle, computePitch(me.pitch));
            native.audioSetPan(_meHandle, computePan(me.pan));
        }
    };
    AudioManager.fadeOutMe = function (duration) {
        if (_meHandle >= 0) native.audioFade(_meHandle, 1.0, 0, Math.round(duration * 1000));
    };
    AudioManager.stopMe = function () {
        if (_meHandle >= 0) {
            native.audioStop(_meHandle);
            native.audioUninit(_meHandle);
            _meHandle = -1;
            if (_bgmHandle >= 0 && this._currentBgm && !native.audioIsPlaying(_bgmHandle)) {
                _bgmHandle = native.audioPlay(audioPath("bgm/", this._currentBgm.name), computeVolume(this._bgmVolume, this._currentBgm.volume), true, computePitch(this._currentBgm.pitch), computePan(this._currentBgm.pan));
                if (_bgmHandle >= 0 && this._currentBgm.pos > 0) native.audioSeek(_bgmHandle, this._currentBgm.pos);
            }
        }
    };
    AudioManager.playSe = function (se) {
        if (se.name) {
            var latest = _seHandles.filter(function (s) { return s.frameCount === Graphics.frameCount; });
            if (latest.some(function (s) { return s.name === se.name; })) return;
            var h = native.audioPlay(audioPath("se/", se.name), computeVolume(this._seVolume, se.volume), false, computePitch(se.pitch), computePan(se.pan));
            _seHandles.push({ handle: h, name: se.name, frameCount: Graphics.frameCount });
            this.cleanupSe();
        }
    };
    AudioManager.updateSeParameters = function (buffer, se) {};
    AudioManager.cleanupSe = function () {
        var alive = [];
        for (var i = 0; i < _seHandles.length; i++) {
            var s = _seHandles[i];
            if (s.handle >= 0 && native.audioIsPlaying(s.handle)) { alive.push(s); }
            else { stopHandle(s.handle); }
        }
        _seHandles = alive;
    };
    AudioManager.stopSe = function () {
        for (var i = 0; i < _seHandles.length; i++) stopHandle(_seHandles[i].handle);
        _seHandles = [];
    };
    AudioManager.playStaticSe = function (se) {
        if (se.name) {
            this.loadStaticSe(se);
            for (var i = 0; i < _staticHandles.length; i++) {
                if (_staticHandles[i].name === se.name) {
                    native.audioStop(_staticHandles[i].handle);
                    var vol = computeVolume(this._seVolume, se.volume);
                    native.audioSetVolume(_staticHandles[i].handle, vol);
                    var h = native.audioPlay(audioPath("se/", se.name), vol, false, computePitch(se.pitch), computePan(se.pan));
                    _staticHandles[i].handle = h;
                    break;
                }
            }
        }
    };
    AudioManager.loadStaticSe = function (se) {
        if (se.name && !this.isStaticSe(se)) {
            var h = native.audioPlay(audioPath("se/", se.name), 0, false, 1.0, 0);
            native.audioStop(h);
            _staticHandles.push({ handle: h, name: se.name });
        }
    };
    AudioManager.isStaticSe = function (se) {
        for (var i = 0; i < _staticHandles.length; i++) {
            if (_staticHandles[i].name === se.name) return true;
        }
        return false;
    };
    AudioManager.stopAll = function () { this.stopMe(); this.stopBgm(); this.stopBgs(); this.stopSe(); };
    AudioManager.saveBgm = function () {
        if (this._currentBgm) {
            var bgm = this._currentBgm;
            return { name: bgm.name, volume: bgm.volume, pitch: bgm.pitch, pan: bgm.pan, pos: _bgmHandle >= 0 ? native.audioGetCursor(_bgmHandle) : 0 };
        }
        return this.makeEmptyAudioObject();
    };
    AudioManager.saveBgs = function () {
        if (this._currentBgs) {
            var bgs = this._currentBgs;
            return { name: bgs.name, volume: bgs.volume, pitch: bgs.pitch, pan: bgs.pan, pos: _bgsHandle >= 0 ? native.audioGetCursor(_bgsHandle) : 0 };
        }
        return this.makeEmptyAudioObject();
    };
    AudioManager.createBuffer = function (folder, name) {
        return { name: name, frameCount: Graphics.frameCount, play: function(){}, stop: function(){}, destroy: function(){}, fadeIn: function(){}, fadeOut: function(){}, seek: function(){ return 0; }, isPlaying: function(){ return false; }, isError: function(){ return false; }, retry: function(){}, addStopListener: function(){}, addLoadListener: function(){}, volume: 0, pitch: 1, pan: 0 };
    };
    AudioManager.checkErrors = function () {};
    Object.defineProperty(AudioManager, "bgmVolume", {
        get: function () { return _bgmVolume; },
        set: function (value) { _bgmVolume = value; this.updateBgmParameters(this._currentBgm); },
        configurable: true
    });
    Object.defineProperty(AudioManager, "bgsVolume", {
        get: function () { return _bgsVolume; },
        set: function (value) { _bgsVolume = value; this.updateBgsParameters(this._currentBgs); },
        configurable: true
    });
    Object.defineProperty(AudioManager, "meVolume", {
        get: function () { return _meVolume; },
        set: function (value) { _meVolume = value; this.updateMeParameters(this._currentMe); },
        configurable: true
    });
    Object.defineProperty(AudioManager, "seVolume", {
        get: function () { return _seVolume; },
        set: function (value) { _seVolume = value; },
        configurable: true
    });
    print("[audio_shims] Native audio backend installed OK");
})();
