# Sonar.js
Sonar.js : (Salaxios Open NAtive Runtime). A first of its kind, non-browser/DOM javascript desktop native runtime written in C, for PixiJS v5 WebGL applications with a focus on being a game wrapper for RPG Maker MZ games. Built as an accessory to the Salaxios Narrative Engine (More info at https://salaxios.github.io)

-Vanilla RPGMaker MZ Games will run currently with, graphical bugs surrounding text rendering.

-Fonts do not work, it just loads a default font.

-Community plugin support is highly variable, many if not most do not work yet. (FOSSIL should theoretically work, VisuStella does not work yet)

-Saving/Loading do not work yet

-No Audio yet

-Battle scenes will load however:

-Effekseer particle effects are not intended to be implimented at this stage. Wasm is not regular WebGL/Javascript and cannot be implimented with QuickJS.
(MV style .png battle animations should still work)

-Video playback not intended to be implimented at this stage.

-Touch UI support not yet implimented, and not a focus at this stage.

-Basic keyboard functions like Z/X, Up, Right, Left, Down, Shift, etc. work.

compile with:
cmake -S . -B build
cmake --build build
ResourceHacker can be used to apply icon.ico to the Sonar.js executable.

It is recommended to experiment with basic RPGMaker MZ games downloaded from Itch.io, however all Battle animations that use Effekseer will not play and will cause the game to hang at this stage. Should be replaced with either MV style png animations inside the RPGMaker Editor, or at some point in the future we will make the effekseer animations inert but have the engine continue playing anyways.
