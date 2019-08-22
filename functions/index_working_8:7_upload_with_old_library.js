let Client = require('ssh2-sftp-client');
var parser = require('xml2json');
var builder = require('xmlbuilder');
const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');
var WooCommerceAPI = require('woocommerce-api');
var nodemailer = require('nodemailer');

var sftpConfig = {
    host: 'sftp.be.bleckmann.com',
    port: '22',
    username: 'WONDERBUCKLE',
    password: '####',
    readyTimeout: 99999
};

var options = {
    object: true,
    reversible: false,
    coerce: false,
    sanitize: true,
    trim: true,
    arrayNotation: false,
    alternateTextNode: false
};

var transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'wonderbuckle.bleckmann@gmail.com',
      pass: '###'
    }
});
  
var mailOptions = {
    from: 'wonderbuckle.bleckmann@gmail.com',
    to: 'robin@gafas.be',
    subject: 'Connection with Bleckmann failed',
    text: ''
};

let sftp = new Client();
const app = express();

var WooCommerce = new WooCommerceAPI({
    url: 'https://wonderbstaging.wpengine.com',
    consumerKey: 'CK_KEY',
    consumerSecret: 'CS_SECRET',
    wpAPI: true,
    version: 'wc/v3'
});

sftp.connect(sftpConfig).then(() => {
    return sftp.list('/TEST/OUT/');
}).then((data) => {
    //getOutData(data);
    return;
}).catch((err) => {
    console.log(err, 'catch error FTP connection');
});

const renameFile = (fileName) => {
    sftp.rename("/TEST/OUT/"+fileName, "/TEST/OUT_ARCHIVE/"+fileName).then(()=>{
        //console.log("file moved");
        return;
    }).catch((err) => {
        console.log(err, 'catch error move file out to out_archive');
    });
}

const getOutData = (data) =>{
    data.forEach(file => {

        sftp.get('/TEST/OUT/'+file.name).then((chunk) => {
            var xml_data = chunk.toString('utf8');

            if(file.name.includes("stdctnext")||file.name.includes("STDCTNEXT")){
                updateOrderDataWC(xml_data);
            }
            if(file.name.includes("stdstoext")||file.name.includes("STDSTOEXT")){
                updateStockWC(xml_data);
            }

            renameFile(file.name);
            
            return;
        }).catch((err)=>{
            console.log("error:", err)
        });
    });
}

const updateOrderDataWC = (xml) => {
    var json = parser.toJson(xml, options);
    putTrackingToWC(json['ns0:CTN'].Header.Order_ID, json['ns0:CTN'].Containers.Container.Trackingnumber, json['ns0:CTN'].Header.Carrier_ID, json['ns0:CTN'].Header.Shipped_Date);
}

const updateStockWC = (xml) =>{
    var json = parser.toJson(xml, options);
    json['ns0:STO'].Inventory.forEach(inventory => {
        var productId = inventory.SKU_ID.substring(0, inventory.SKU_ID.indexOf('-'));
        putStockToWC(productId, inventory.QTY_Free);
    });
}

const putStockToWC = (sku, qty) =>{
    var data;
    if(qty > 5 ){
        data = {
            stock_quantity: qty,
            stock_status: "instock"
        };
    }else{
        data = {
            stock_quantity: 0,
            stock_status: "outofstock"
        };
    }
    
    WooCommerce.put("products/"+sku, data, (err, data, res) => {
        if(err) console.log(err, 'catch error put products');
        //console.log("stock updated");
    });
}

const putTrackingToWC = (orderId, trackingNumber, carrier, date) => {
    var data = {
        status: "completed",
        meta_data: [
            {
                key: "ywot_tracking_code",
                value: trackingNumber
            },
            {
                key: "ywot_pick_up_date",
                value: date
            },
            {
                key: "ywot_carrier_name",
                value: carrier
            },
            {
                key: "ywot_picked_up",
                value: "on"
            }
        ]
    };
    
    WooCommerce.put("orders/"+orderId, data, (err, data, res) => {
        if(err) console.log(err, 'catch error put order');
        //console.log("tracking updated");
    });
}

const putOrdersIn = (order) => {
    //TODO: check different shipping types
    console.log("new order: "+order.id);

    var date = new Date(order.date_created).toISOString().
        replace(/T/, '').
        replace(/-/, '').
        replace(/-/, '').
        replace(/:/, '').
        replace(/:/, '').    
        replace(/\..+/, '');

    /* Generate XML */
    var dispatch_method = "STANDARD";
    if(order.shipping_lines[0].method_title === "Express"){
        dispatch_method = "EXPRESS";
    }
    var root = builder.create('dcsmergedata', {version: '1.0', encoding: 'utf-8'})
        .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
        .att('xsi:noNamespaceSchemaLocation', '../lib/interface_order_header.xsd')
        .ele('dataheaders')
        .ele('dataheader', {'transaction':'add'})
        .ele('address1', order.shipping.address_1).up()
        .ele('address2', order.shipping.address_2).up()
        .ele('client_id', 'WONDERBUCK').up()
        .ele('contact_email', order.billing.email).up()
        .ele('contact_phone', order.billing.phone).up()
        .ele('country', order.shipping.country).up()
        .ele('customer_id', order.customer_id).up()
        .ele('dispatch_method', dispatch_method).up()
        .ele('freight_terms', dispatch_method).up()
        .ele('from_site_id', 'KH').up()
        .ele('instructions', order.customer_note).up()
        .ele('name', order.shipping.first_name + " " + order.shipping.last_name).up()
        .ele('order_date', date).up()
        .ele('order_id', order.id).up()
        .ele('owner_id', '01').up()
        .ele('postcode', order.shipping.postcode).up()
        .ele('town', order.shipping.city).up()
        .ele('datalines');
    order.line_items.forEach((line_item, index) => {
        if(line_item.meta_data[0].key === "bracelet_sku"){
            var lineNote = builder.create('dataline').att('transaction','add')
                .ele('client_id', 'WONDERBUCK').up()
                .ele('condition_id', 'OK1').up()
                .ele('line_id', index+1).up()
                .ele('order_id', order.id).up()
                .ele('product_currency', order.currency).up()
                .ele('product_price', line_item.price).up()
                .ele('qty_ordered', line_item.quantity).up()
                .ele('sku_id', line_item.sku).up()
                .ele('user_def_note_2', line_item.meta_data[0].value).up();
            root.importDocument(lineNote);
        } else {
            var line = builder.create('dataline').att('transaction','add')
                .ele('client_id', 'WONDERBUCK').up()
                .ele('condition_id', 'OK1').up()
                .ele('line_id', index+1).up()
                .ele('order_id', order.id).up()
                .ele('product_currency', order.currency).up()
                .ele('product_price', line_item.price).up()
                .ele('qty_ordered', line_item.quantity).up()
                .ele('sku_id', line_item.sku).up();
            root.importDocument(line);
        }
    });
    
    var xml = root.end({ pretty: true});
    console.log(xml);

    /* Upload XML to FTP as buffer */
    var dataBuffer = Buffer.from(xml);

    return sftp.put(dataBuffer, "/TEST/IN/WONDERBUCK_ORD_IN_"+date+".xml").then(() => {
        return console.log("order #"+order.id+" is uploaded to Bleckmann");

        /*sftp.put(dataBuffer, "/TEST/OUT/WONDERBUCK_ORD_IN_"+date+".xml").then(() => {
            return;
        }).catch((err)=>{
            console.log("upload error new order to out folder for test:", err);
            return;
        });

        return;*/
    }).catch((err)=>{
        mailOptions.text = 'Failed to upload order: '+order.id;
        transporter.sendMail(mailOptions, (error, info)=>{
            if (error) {
                console.log("Email error: ", error);
                return;
            } else {
                console.log('Email sent: ' + info.response);
                return;
            }
          });
        console.log("upload error:", err);
        return;
    });

}

/* Firebase Functions for REST API call */
app.use(cors({ origin: true }));

// build multiple CRUD interfaces:
//app.get('/:id', (req, res) => res.send(Widgets.getById(req.params.id)));
app.post('/', (req, res) => {
    console.log(req.body);
    if(req.body.status === "processing"){
        putOrdersIn(req.body);
    }
    res.send();
});

const ListOutFolder = () => {
    sftp.connect(sftpConfig).then(() => {
        return sftp.list('/TEST/OUT/');
    }).then((data) => {
        console.log(data);
        if(data.length>0){
            console.log("data to update. Files to update: "+data.length);
            getOutData(data);
        }
        return("done");
    }).catch((err) => {
        console.error(err, 'catch error FTP connection schedule');
    });
    return("done");
}

exports.order = functions.https.onRequest(app);

exports.scheduledFunction = functions.pubsub.schedule('every 30 minutes').onRun((context) => {
    return ListOutFolder();
});