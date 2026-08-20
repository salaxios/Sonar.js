# Sonar.js <img width="48" height="48" alt="image" src="https://github.com/user-attachments/assets/c5cfd653-437a-44fc-9cee-8deff0dae503" />

Sonar.js : (Salaxios Open NAtive Runtime). A first of its kind, non-browser/DOM javascript desktop native runtime written in C, for PixiJS v5 WebGL applications with a focus on being a game wrapper for RPG Maker MZ games. Built as an accessory to the Salaxios Narrative Engine (More info at https://salaxios.github.io). Originally titled Salaxios WebGLEmu

Ultimate goal/direction to work toward is to create something like or similar to EasyRPG but for RPGMaker MZ (or for PixiJS v5 in general, since EasyRPG is just an RPGMaker interpreter and not a complete software emulation layer).

Experimental changes:

- Tracy profiler implemented to profile lag, so that we can optimize.
- Improved but incomplete Support for Bitmap text rendering plugin (WIP)

Ultramode 7 proof of concept:
<img width="1187" height="663" alt="image" src="https://github.com/user-attachments/assets/52dad355-3b80-4fc1-a87d-3182c29a1398" />


Bonus: Screenshots from Salaxios' The Locust (which utilises LOTS of highly visual plugins, a majority of which ran).

Bitmap Text & map title window rendering improved & different

<img width="973" height="582" alt="image" src="https://github.com/user-attachments/assets/8abcdd84-c12b-4204-95d8-74e6ce3b4374" />


- Vanilla RPGMaker MZ Games will run currently with, graphical bugs surrounding text rendering.
 
- Fonts do not work, it just loads a default font.

- Icons in text do not yet work (the entire icon sheet shows up in a small frame, not the specific icon)

- Faces do not yet work, (entire face sheet shows up in a textbox for any actor or message whose designated face is on that sheet)

- Community plugin support is highly variable, many do not work yet. Some will load, others will break the game, many will not work as intended.(FOSSIL should theoretically work, VisuStella does not work yet, UltraMode7 Works).

- Saving/Loading do not work yet

- No Audio yet

- Battle scenes will load however:

- Effekseer particle effects are not intended to be implimented at this stage. Wasm is not regular WebGL/Javascript and cannot be implimented with QuickJS.
(MV style .png battle animations should still work)

- Video playback not intended to be implimented at this stage.

- Touch UI support not yet implimented, and not a focus at this stage.

- Basic keyboard functions like Z/X, Up, Right, Left, Down, Shift, etc. work.

Check compile_instructions.txt for info on how to compile.

It is recommended to experiment with basic RPGMaker MZ games downloaded from Itch.io, plugins welcome, VisuStella has known issues at the moment and are not yet supported. 

IMPORTANT NOTE: All Battle animations that use Effekseer will not play and will cause the game to hang at this stage. Should be replaced with either MV style png animations inside the RPGMaker Editor, or at some point in the future we will make the effekseer animations inert but have the engine continue playing anyways. we will make the effekseer animations inert but have the engine continue playing anyways.
