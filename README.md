# Sonar.js <img width="48" height="48" alt="image" src="https://github.com/user-attachments/assets/e111f7e3-323e-4b21-9220-2a43aba554fc" />
Sonar.js : (Salaxios Open NAtive Runtime). A first of its kind, non-browser/DOM javascript desktop native runtime written in C, for PixiJS v5 WebGL applications with a focus on being a game wrapper for RPG Maker MZ games. Built as an accessory to the Salaxios Narrative Engine (More info at https://salaxios.github.io). Originally titled Salaxios WebGLEmu

Ultramode 7 proof of concept:
<img width="1187" height="663" alt="image" src="https://github.com/user-attachments/assets/52dad355-3b80-4fc1-a87d-3182c29a1398" />


Bonus: Screenshots from Salaxios' The Locust (which utilises LOTS of highly visual plugins, a majority of which ran).

<img width="967" height="590" alt="image" src="https://github.com/user-attachments/assets/5a2f1f3f-2190-4fc5-9c8b-e195126dd80e" />

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

Ultimate goal/direction to work toward is to create something like or ~~similar to EasyRPG~~ but for RPGMaker MZ (or for PixiJS v5 in general, since EasyRPG is just an RPGMaker interpreter and not a complete software compatibility layer).

**Important notes regarding project direction:**
-------------------------------------------------------
- Most basic games with few plugins run at good framerates besides JSON parsing slowdowns. The real problem comes with games that use GALV's Layers, Shora's Lighting etc. The truth we have to accept is that this is not and will never be a drag and drop framework nor will it be an automatic AOT compiling native speed porting engine. It takes years of work and hundreds of thousands of dollars to build a complete JS to C/C++ transpiler and all the existing ones are proprietary, so that is not the point of this project.

What we can do instead: 

- Write compatibility shims for individual common plugins to shift demanding JS logic to C. This will maximize compatibility and performance many in the general RPGMaker MZ community, however it will never guarantee universal performance for every individual case.

- For simple RPGMaker MZ game with minimal plugins and MV style battle animations instead of Effekseer, then this is pretty much drag and drop. (If you want to just play shovelware off of itch.io)

- **The ultimate goal is to get as much compatibility with as many plugins and as many versions of those plugins as possible. Because the project is currently only being maintained by one dev at Salaxios Studio right now, only the major community plugins used by Salaxios' current game, "The Locust" are being targeted at the moment, however other contributors are welcome to work on their own plugin optimization and compatibility shims.**

- Thus, at core, Sonar.JS is a DIY native runtime framework core that you can use to compile your game for different platforms natively, think of it as a publically available barebones starting point for porting. However it will require you to optimize your own custom plugins and write your own optimization code in C for the plugins that are not supported by the publically available version of the project.

compile with:

cmake -S . -B build

cmake --build build

or:
cmake -S . -B build && cmake --build build --config Release
