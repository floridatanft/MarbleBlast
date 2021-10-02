import { Menu } from "./menu";

export abstract class HelpScreen {
	div: HTMLDivElement;
	homeButton: HTMLImageElement;
	homeButtonSrc: string;

	constructor(menu: Menu) {
		this.initProperties();

		menu.setupButton(this.homeButton, this.homeButtonSrc, () => {
			// Close help and go back to the main menu
			this.hide();
			menu.home.show();
		});
	}

	abstract initProperties(): void;

	show() {
		this.div.classList.remove('hidden');
	}

	hide() {
		this.div.classList.add('hidden');
	}
}