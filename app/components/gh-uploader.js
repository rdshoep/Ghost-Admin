import Component from 'ember-component';
import {isEmberArray} from 'ember-array/utils';
import injectService from 'ember-service/inject';
import {isEmpty} from 'ember-utils';
import {task, all} from 'ember-concurrency';
import ghostPaths from 'ghost-admin/utils/ghost-paths';
import EmberObject from 'ember-object';

// TODO: this is designed to be a more re-usable/composable upload component, it
// should be able to replace the duplicated upload logic in:
// - gh-image-uploader
// - gh-file-uploader
// - gh-koenig/cards/card-image
// - gh-koenig/cards/card-markdown
//
// In order to support the above components we'll need to introduce an
// "allowMultiple" attribute so that single-image uploads don't allow multiple
// simultaneous uploads

const UploadTracker = EmberObject.extend({
    file: null,
    total: 0,
    loaded: 0,

    init() {
        this.total = this.file && this.file.size || 0;
    },

    update({loaded, total}) {
        this.total = total;
        this.loaded = loaded;
    }
});

export default Component.extend({
    tagName: '',

    ajax: injectService(),
    notifications: injectService(),

    // Public attributes
    accept: '',
    extensions: null,
    files: null,
    paramName: 'uploadimage', // TODO: is this the best default?
    uploadUrl: null,

    // Interal attributes
    errors: null, // [{fileName: 'x', message: 'y'}, ...]
    totalSize: 0,
    uploadedSize: 0,
    uploadPercentage: 0,
    uploadUrls: null, // [{filename: 'x', url: 'y'}],

    // Private
    _defaultUploadUrl: '/uploads/',
    _files: null,
    _isUploading: false,
    _uploadTrackers: null,

    // Closure actions
    onCancel() {},
    onComplete() {},
    onFailed() {},
    onStart() {},
    onUploadFail() {},
    onUploadSuccess() {},

    // Optional closure actions
    // validate(file) {}

    init() {
        this._super(...arguments);
        this.set('errors', []);
        this.set('uploadUrls', []);
        this._uploadTrackers = [];
    },

    didReceiveAttrs() {
        this._super(...arguments);

        // set up any defaults
        if (!this.get('uploadUrl')) {
            this.set('uploadUrl', this._defaultUploadUrl);
        }

        // if we have new files, validate and start an upload
        let files = this.get('files');
        if (files && files !== this._files) {
            if (this._isUploading) {
                throw new Error('Adding new files whilst an upload is in progress is not supported.');
            }

            this._files = files;

            // we cancel early if any file fails client-side validation
            if (this._validate()) {
                this.get('_uploadFiles').perform(files);
            }
        }
    },

    _validate() {
        let files = this.get('files');
        let validate = this.get('validate') || this._defaultValidator.bind(this);
        let ok = [];
        let errors = [];

        for (let file of files) {
            let result = validate(file);
            if (result === true) {
                ok.push(file);
            } else {
                errors.push({fileName: file.name, message: result});
            }
        }

        if (isEmpty(errors)) {
            return true;
        }

        this.set('errors', errors);
        this.onFailed(errors);
        return false;
    },

    // we only check the file extension by default because IE doesn't always
    // expose the mime-type, we'll rely on the API for final validation
    _defaultValidator(file) {
        let extensions = this.get('extensions');
        let [, extension] = (/(?:\.([^.]+))?$/).exec(file.name);

        if (!isEmberArray(extensions)) {
            extensions = extensions.split(',');
        }

        if (!extension || extensions.indexOf(extension.toLowerCase()) === -1) {
            let validExtensions = `.${extensions.join(', .').toUpperCase()}`;
            return `The image type you uploaded is not supported. Please use ${validExtensions}`;
        }

        return true;
    },

    _uploadFiles: task(function* (files) {
        let uploads = [];

        this.onStart();

        for (let file of files) {
            uploads.push(this.get('_uploadFile').perform(file));
        }

        // populates this.errors and this.uploadUrls
        yield all(uploads);

        this.onComplete(this.get('uploadUrls'));
    }).drop(),

    _uploadFile: task(function* (file) {
        let ajax = this.get('ajax');
        let formData = this._getFormData(file);
        let url = `${ghostPaths().apiRoot}${this.get('uploadUrl')}`;

        let tracker = new UploadTracker({file});
        this.get('_uploadTrackers').pushObject(tracker);

        try {
            let response = yield ajax.post(url, {
                data: formData,
                processData: false,
                contentType: false,
                dataType: 'text',
                xhr: () => {
                    let xhr = new window.XMLHttpRequest();

                    xhr.upload.addEventListener('progress', (event) => {
                        tracker.update(event);
                        this._updateProgress();
                    }, false);

                    return xhr;
                }
            });

            // TODO: is it safe to assume we'll only get a url back?
            let uploadUrl = JSON.parse(response);

            this.get('uploadUrls').push({
                fileName: file.name,
                url: uploadUrl
            });

            return true;

        } catch (error) {
            console.log('error', error); // eslint-disable-line

            // TODO: check for or expose known error types?
            this.get('errors').push({
                fileName: file.name,
                message: error.errors[0].message
            });
        }
    }),

    // NOTE: this is necessary because the API doesn't accept direct file uploads
    _getFormData(file) {
        let formData = new FormData();
        formData.append(this.get('paramName'), file);
        return formData;
    },

    // TODO: this was needed because using CPs directly resulted in infrequent updates
    // - I think this was because updates were being wrapped up to save
    // computation but that hypothesis needs testing
    _updateProgress() {
        let trackers = this._uploadTrackers;

        let totalSize = trackers.reduce((total, tracker) => {
            return total + tracker.get('total');
        }, 0);

        let uploadedSize = trackers.reduce((total, tracker) => {
            return total + tracker.get('loaded');
        }, 0);

        this.set('totalSize', totalSize);
        this.set('uploadedSize', uploadedSize);

        if (totalSize === 0 || uploadedSize === 0) {
            return;
        }

        let uploadPercentage = Math.round((uploadedSize / totalSize) * 100);
        this.set('uploadPercentage', uploadPercentage);
    },

    _reset() {
        this.set('errors', null);
        this.set('totalSize', 0);
        this.set('uploadedSize', 0);
        this.set('uploadPercentage', 0);
        this._uploadTrackers = [];
        this._isUploading = false;
    },

    actions: {
        cancel() {
            this._reset();
            this.onCancel();
        }
    }
});
