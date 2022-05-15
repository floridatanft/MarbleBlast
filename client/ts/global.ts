import { Game } from "./game/game";
import { Lobby } from "./net/lobby";
import { Menu } from "./ui/menu";

/** A global state object at the top of the reference chain. */
export const G = {
	modification: null as 'gold' | 'platinum',
	game: null as Game,
	menu: null as Menu,
	lobby: null as Lobby
};