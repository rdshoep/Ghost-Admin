import Controller from 'ember-controller';
import injectService from 'ember-service/inject';
import {task} from 'ember-concurrency';
import {alias} from 'ember-computed';

export default Controller.extend({
    notifications: injectService(),
    settings: injectService(),

    model: alias('settings.amp'),

    save: task(function* () {
        let amp = this.get('model');
        let settings = this.get('settings');

        settings.set('amp', amp);

        try {
            return yield settings.save();

        } catch (error) {
            this.get('notifications').showAPIError(error);
            throw error;
        }
    }).drop(),

    actions: {
        update(value) {
            this.set('model', value);
        }
    }
});
