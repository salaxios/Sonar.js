# Sonar.js <img width="48" height="48" alt="image" src="https://github.com/user-attachments/assets/c5cfd653-437a-44fc-9cee-8deff0dae503" />

Sonar.js : (Salaxios Open NAtive Runtime). A first of its kind, non-browser/DOM javascript desktop native runtime written in C, for PixiJS v5 WebGL applications with a focus on being a game wrapper for RPG Maker MZ games. Built as an accessory to the Salaxios Narrative Engine (More info at https://salaxios.github.io). Originally titled Salaxios WebGLEmu

Ultimate goal/direction to work toward is to create something like or similar to MXKP but for RPGMaker MZ (or for PixiJS HTML5 games in general).

Experimental changes:

- Tracy profiler implemented to profile lag, so that we can optimize.
- Highly improved but incomplete Support for Bitmap text rendering plugin (WIP)
- Support for several of the base VisuStella plugins has been added

Ultramode 7 proof of concept:
<img width="1187" height="663" alt="image" src="https://github.com/user-attachments/assets/52dad355-3b80-4fc1-a87d-3182c29a1398" />


Bonus: Screenshots from Salaxios' The Locust (which utilises LOTS of highly visual plugins, a majority of which ran).

Bitmap Text & map title window rendering improved & different (NOTE THIS IMAGE IS OLD. BITMAP TEXT RENDERING IS MUCH IMPROVED, THE TEXT NO LONGER HAS THE GLITCHY WHITE BOXES BEHIND IT)

<img width="973" height="582" alt="image" src="https://github.com/user-attachments/assets/8abcdd84-c12b-4204-95d8-74e6ce3b4374" />


- Vanilla RPGMaker MZ Games will run currently with, graphical bugs surrounding text rendering.
  
- Only PixiJS v5 has been implemented yet. Contributions that add compatibility for other versions of PixiJS or other frameworks are welcome! 

- Fonts do not work, it just loads a default font.

- Icons in text do not yet work (the entire icon sheet shows up in a small frame, not the specific icon)

- Character faces work !
 
- Community plugin support is highly variable, many do not work yet. Some will load, others will break the game, many will not work as intended.(FOSSIL should theoretically work, VisuStella does not work yet, UltraMode7 Works).

- Saving/Loading games do not work yet, but this is a trivial fix, just need to rig up translation layer for the file IO that RPGMaker MZ usually uses in NW.JS

- Audio has been added! a few glitches when multiple sound effects are attempted to be played over each other.

- Battle scenes will load however:

- Effekseer particle effects are not yet implimented at this stage. Wasm is not regular WebGL/Javascript and cannot be implimented with QuickJS. C++ version of Effekseer will need to be added to replace the .wasm binary. -> https://effekseer.github.io/
(MV style .png battle animations should still work)

- Video playback not yet implimented.

- Touch UI support not yet implimented.

- Basic keyboard functions like Z/X, Up, Right, Left, Down, Shift, etc. work.

Check compile_instructions.txt for info on how to compile.



IMPORTANT NOTE: All Battle animations that use Effekseer will not play and will cause the game to hang at this stage. Should be replaced with either MV style png animations inside the RPGMaker Editor until effekseer support can be worked on.
