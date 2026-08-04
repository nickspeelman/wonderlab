Required filenames:

pickup.mp3      — object picked up / drag begins
drop.mp3        — object released or thrown
collision.mp3   — two objects collide above the impact threshold
bounce.mp3      — object hits a wall or floor above the impact threshold
spawn.mp3       — a new shape is added
remove.mp3      — the newest shape is removed

Collision and bounce sounds are rate-limited. Quiet impacts remain silent, and
when many collisions happen together the code favors the strongest impact.
