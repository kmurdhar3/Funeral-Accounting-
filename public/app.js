// Small progressive enhancements; every form still works without JavaScript.
(function () {
  // Amount follows the ticked months until the person types their own amount
  document.querySelectorAll('form[data-autoamount]').forEach(function (form) {
    var amount = form.querySelector('input[name=amount]');
    var boxes = form.querySelectorAll('input[name=months]');
    if (!amount) return;
    amount.addEventListener('input', function () { amount.dataset.touched = '1'; });
    function update() {
      if (amount.dataset.touched) return;
      var cents = 0;
      boxes.forEach(function (b) { if (b.checked) cents += Number(b.dataset.amount || 0); });
      amount.value = cents ? (cents / 100).toFixed(2) : '';
    }
    boxes.forEach(function (b) { b.addEventListener('change', update); });
    if (!amount.value) update();
  });

  // Phone photos are often 3-8 MB; shrink them so uploads stay under the server limit
  function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1200 * 1024 || !window.createImageBitmap) {
      return Promise.resolve(file);
    }
    return createImageBitmap(file).then(function (img) {
      var scale = Math.min(1, 1800 / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          resolve(blob && blob.size < file.size
            ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
            : file);
        }, 'image/jpeg', 0.82);
      });
    }).catch(function () { return file; });
  }

  document.querySelectorAll('form[data-receipt]').forEach(function (form) {
    var input = form.querySelector('input[type=file]');
    var button = form.querySelector('button[type=submit], button:not([type])');
    var busy = false;
    form.addEventListener('submit', function (e) {
      if (busy) return;
      if (!form.querySelector('input[name=months]:checked')) {
        e.preventDefault();
        alert('Select the month(s) this payment is for.');
        return;
      }
      if (!input || !input.files.length || !window.DataTransfer) return;
      e.preventDefault();
      busy = true;
      if (button) { button.disabled = true; button.textContent = 'Uploading…'; }
      shrink(input.files[0]).then(function (file) {
        if (file.size > 4 * 1024 * 1024) {
          alert('The receipt is larger than 4 MB. Please choose a smaller photo or PDF.');
          busy = false;
          if (button) { button.disabled = false; button.textContent = 'Submit for approval'; }
          return;
        }
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        form.submit();
      });
    });
  });
})();
