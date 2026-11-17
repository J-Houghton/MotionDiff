# Experimental model options

Two options load a neural network and run it beside the normal picture.
Both are marked **experimental** in the demo. They work, but their answers
are estimates, they are slow on some machines, and they have been tested on
few.

Both appear in the parameter panel (key **P**), in the folder named after
the mode (*Motion mask* or *Background model*), once *Cut out the movers*
has **Movers: boxed & numbered** on.

| Option in the panel | What it does | Download |
|---|---|---|
| **Name the movers** | An object detector looks at the whole picture a few times a second and puts its best guess ("car", "person", "bird") on the boxes | 21–41 MB, plus the software that runs it |
| **Depth the scene** | A depth model estimates how far away each part of the scene is, and box speeds are scaled so that far and near movers can be compared. **Show the depth estimate** draws the depth picture | about 25 MB |

Nothing is downloaded until you switch an option on. The model then comes
from Hugging Face and the software from the jsDelivr network, and the
browser keeps both for next time. Your video still stays in your browser.

## Reading the picture

Everything a model says is marked **≈**: it is an estimate, not a
measurement.

| You see | It means |
|---|---|
| A solid box with a name | Found by its movement, and recognised by the model |
| A dashed box | Found by its movement only. The model did not recognise it |
| A dashed blue box | Found by the model only, on its last look. Often something that is not moving, such as a parked car |
| A speed marked ≈ | Scaled by the depth estimate. An unmarked speed is the plain measurement |

## What to expect

- **Speed depends on the machine.** The demo tries the graphics card first
  and falls back to the processor, and the status line says which it got.
  On a graphics card a look takes under half a second. On the processor it
  takes one to two seconds, few boxes get a name, and the model's own finds
  (the dashed blue boxes) are not drawn.
- **Names are sparse.** On the *Motorway* sample about a quarter of the
  boxes get one. Small, distant and short-lived boxes usually do not.
- **The model misreads.** A lorry has been named "train". Read a name as a
  guess, and trust it least on small or unusual things.
- **A group takes one name.** One box over a queue of cars is named after
  the car that fits it best.
- **It costs frame rate.** On a laptop's built-in graphics the picture ran
  at 24 frames a second with naming on, against 30 with it off.
- **Depth is relative.** It says what is nearer and further, not how far in
  metres, and a light or dark surface can be mistaken for distance.

*Name the movers* is confirmed working in Chrome on a desktop graphics card
and on a phone. When either option is on, the readings column gains *Copy
model readings* or *Copy depth readings*, which copies the timings as text.

The full status, with what has and has not been checked, is in the project
records: [model options](../../records/model-options.md).
